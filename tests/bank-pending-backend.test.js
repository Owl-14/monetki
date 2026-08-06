import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { bankScopeDiagnostics, baseWriteError, visibleBootstrapData } from "../supabase/functions/api/rules.js";

const source = (name) => readFile(new URL(`../supabase/functions/api/${name}`, import.meta.url), "utf8");

function data() {
  return {
    businesses: [{ id: "dev", active: true }],
    memberships: [{ id: "m", employeeId: "admin", businessId: "dev", active: true }],
    businessOwners: [], employees: [], clients: [], venues: [], players: [], tasks: [], finance: [],
    bankTransactions: [{ id: "queue-1", bankId: "secret-bank-id", amount: 100, date: "2026-08-05" }],
    staffExpenses: [], cash: [], notifications: [],
  };
}

test("необработанные банковские операции приходят только администратору", () => {
  const admin = visibleBootstrapData({ id: "admin", role: "admin" }, data());
  const staff = visibleBootstrapData({ id: "staff", role: "staff" }, data());

  assert.equal(admin.bankTransactions.length, 1);
  assert.equal(admin.bankDiagnostics.queue.count, 1);
  assert.deepEqual(staff.bankTransactions, []);
  assert.equal(staff.bankDiagnostics, null);
  assert.match(baseWriteError({ role: "admin" }, "bankTransactions"), /только провести/);
});

test("диагностика отличает неверный, архивный и недоступный бизнес без банковских данных", () => {
  const input = data();
  input.bankTransactions.push({ id: "bad-date", bankId: "hidden", amount: 200, date: "2026-99-99" });
  input.businesses.push(
    { id: "archive", active: false },
    { id: "other", active: true },
  );
  input.finance = [
    { id: "valid", businessId: "dev", unit: "dev", source: "bank", date: "2026-07-19", amount: 1 },
    { id: "all", businessId: "all", unit: "all", source: "bank", date: "2026-07-22", amount: 2 },
    { id: "missing", source: "bank", date: "2026-07-23", amount: 3 },
    { id: "mismatch", businessId: "dev", unit: "other", source: "bank", date: "2026-08-01", amount: 4 },
    { id: "ghost", businessId: "ghost", unit: "ghost", source: "bank", date: "2026-08-04", amount: 5 },
    { id: "archive", businessId: "archive", unit: "archive", source: "bank", date: "2026-07-20", amount: 6 },
    { id: "other", businessId: "other", unit: "other", source: "bank", date: "2026-07-21", amount: 7 },
    { id: "manual", businessId: "ghost", unit: "ghost", source: "manual", date: "2026-08-06", amount: 8 },
  ];

  const result = bankScopeDiagnostics({ id: "admin", role: "admin" }, input);
  assert.deepEqual(result.queue, { count: 2, earliestDate: "2026-08-05", latestDate: "2026-08-05" });
  assert.deepEqual(result.hiddenInvalidScope, { count: 4, earliestDate: "2026-07-22", latestDate: "2026-08-04" });
  assert.deepEqual(result.hiddenInvalidScopeWithoutBankId, { count: 4, earliestDate: "2026-07-22", latestDate: "2026-08-04" });
  assert.deepEqual(result.hiddenArchivedScope, { count: 1, earliestDate: "2026-07-20", latestDate: "2026-07-20" });
  assert.deepEqual(result.hiddenInaccessibleScope, { count: 1, earliestDate: "2026-07-21", latestDate: "2026-07-21" });
  assert.equal(JSON.stringify(result).includes("amount"), false);
  assert.equal(bankScopeDiagnostics({ id: "staff", role: "staff" }, input), null);
});

test("синхронизация пишет очередь и дедуплицирует её вместе с finance", async () => {
  const bank = await source("bank.ts");
  assert.match(bank, /readAll\("finance"\).*readAll\("bankTransactions"\)/s);
  assert.match(bank, /new Set\(\[\.\.\.existing, \.\.\.queued\]/);
  assert.match(bank, /callRpc\("bank_enqueue_transaction"/);
  assert.match(bank, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(bank, /id: await bankQueueRecordId\(bankId\)/);
  assert.doesNotMatch(bank, /writeRow\("finance"/);
});

test("проведение проверяет права, сохраняет bankId и защищено от дубля", async () => {
  const [actions, bankActions, http, migration] = await Promise.all([
    source("actions.ts"),
    source("bank-rule-actions.ts"),
    source("http.ts"),
    readFile(new URL("../supabase/migrations/009_bank_rules.sql", import.meta.url), "utf8"),
  ]);
  const start = actions.indexOf("export async function processBankTransaction");
  const end = actions.indexOf("async function coreValidationError", start);
  const block = actions.slice(start, end);

  assert.match(http, /case "process_bank_transaction"/);
  assert.match(block, /if \(!isAdmin\(u\)\)/);
  assert.match(block, /manualProcessBankTransaction/);
  assert.match(bankActions, /scopeWriteError\(/);
  assert.match(bankActions, /callRpc\("apply_bank_rule_transaction"/);
  assert.doesNotMatch(block, /console\.|error\.message/);
  assert.match(migration, /for update/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /data->>'bankId' = v_bank_id/);
  assert.match(migration, /delete from public\.records where entity = 'bankTransactions'/);
  assert.match(migration, /revoke all on function public\.apply_bank_rule_transaction\(jsonb\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.apply_bank_rule_transaction[\s\S]*to service_role/);
});

test("ошибка Точки не включает тело банковского ответа", async () => {
  const bank = await source("bank.ts");
  assert.match(bank, /throw new Error\(`Точка API \$\{resp\.status\}`\)/);
  assert.doesNotMatch(bank, /body\.slice|Точка API \$\{resp\.status\}:/);
});

test("исторические банковские записи с неверным бизнесом атомарно возвращаются в очередь", async () => {
  const migration = await readFile(
    new URL("../supabase/migrations/006_recover_hidden_bank_transactions.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /finance\.data ->> 'source' = 'bank'/);
  assert.match(migration, /coalesce\(length\(finance\.data ->> 'bankId'\), 0\) > 0/);
  assert.doesNotMatch(migration, /trim\(finance\.data ->> '(?:bankId|businessId|unit)'\)/);
  assert.match(migration, /in \('', 'all'\)/);
  assert.match(migration, /not exists \([\s\S]*business\.entity = 'businesses'/);
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(v_bank_id, 0\)\)/);
  assert.match(migration, /ext\.extname = 'pgcrypto'[\s\S]*%I\.digest\(convert_to\(\$1/);
  assert.match(migration, /v_queue_id := 'bankq:' \|\| v_queue_hash/);
  assert.match(migration, /other\.data ->> 'bankId' = v_bank_id/);
  assert.match(migration, /other\.data ->> 'businessId'[\s\S]*business\.entity = 'businesses'/);
  assert.match(migration, /queued\.data ->> 'bankId' = v_bank_id/);
  assert.match(migration, /movement\.entity = 'stockMovements'[\s\S]*movement\.data ->> 'financeId' = v_record\.id/);
  assert.match(migration, /'bankId', v_bank_id[\s\S]*'date', v_record\.data -> 'date'[\s\S]*'updated', v_now/);
  assert.doesNotMatch(migration, /v_record\.data\s*-\s*'businessId'/);
  assert.match(migration, /insert into public\.records\(entity, id, data\)[\s\S]*'bankTransactions'/);
  assert.match(migration, /delete from public\.records where entity = 'finance'/);
  const insertAt = migration.indexOf("insert into public.records(entity, id, data)");
  const verifyAt = migration.indexOf("v_existing_queue ->> 'bankId' is distinct from v_bank_id");
  const deleteAt = migration.lastIndexOf("delete from public.records where entity = 'finance'");
  assert.ok(insertAt >= 0 && verifyAt > insertAt && deleteAt > verifyAt);
  assert.doesNotMatch(migration, /business\.data ->> 'active'/);
});

test("атомарная функция применяется всеми банковскими workflow", async () => {
  const paths = [
    "../.github/workflows/deploy-backend.yml",
    "../.github/workflows/apply-bank-cron-migration.yml",
    "../.github/workflows/configure-tochka-sync-secret.yml",
  ];
  for (const path of paths) {
    const workflow = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(workflow, /supabase\/migrations\/005_process_bank_transaction\.sql/, path);
    assert.match(workflow, /supabase\/migrations\/006_recover_hidden_bank_transactions\.sql/, path);
    assert.match(workflow, /supabase\/migrations\/009_bank_rules\.sql/, path);
  }
});
