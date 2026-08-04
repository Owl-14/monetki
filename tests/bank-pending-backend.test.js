import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { baseWriteError, visibleBootstrapData } from "../supabase/functions/api/rules.js";

const source = (name) => readFile(new URL(`../supabase/functions/api/${name}`, import.meta.url), "utf8");

function data() {
  return {
    businesses: [{ id: "dev", active: true }],
    memberships: [{ id: "m", employeeId: "admin", businessId: "dev", active: true }],
    businessOwners: [], employees: [], clients: [], venues: [], players: [], tasks: [], finance: [],
    bankTransactions: [{ id: "queue-1", bankId: "secret-bank-id", amount: 100 }],
    staffExpenses: [], cash: [], notifications: [],
  };
}

test("необработанные банковские операции приходят только администратору", () => {
  const admin = visibleBootstrapData({ id: "admin", role: "admin" }, data());
  const staff = visibleBootstrapData({ id: "staff", role: "staff" }, data());

  assert.equal(admin.bankTransactions.length, 1);
  assert.deepEqual(staff.bankTransactions, []);
  assert.match(baseWriteError({ role: "admin" }, "bankTransactions"), /только провести/);
});

test("синхронизация пишет очередь и дедуплицирует её вместе с finance", async () => {
  const bank = await source("bank.ts");
  assert.match(bank, /readAll\("finance"\).*readAll\("bankTransactions"\)/s);
  assert.match(bank, /new Set\(\[\.\.\.existing, \.\.\.queued\]/);
  assert.match(bank, /writeRow\("bankTransactions"/);
  assert.match(bank, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(bank, /id: await bankQueueRecordId\(bankId\)/);
  assert.doesNotMatch(bank, /writeRow\("finance"/);
});

test("проведение проверяет права, сохраняет bankId и защищено от дубля", async () => {
  const [actions, http, migration] = await Promise.all([
    source("actions.ts"),
    source("http.ts"),
    readFile(new URL("../supabase/migrations/005_process_bank_transaction.sql", import.meta.url), "utf8"),
  ]);
  const start = actions.indexOf("export async function processBankTransaction");
  const end = actions.indexOf("async function coreValidationError", start);
  const block = actions.slice(start, end);

  assert.match(http, /case "process_bank_transaction"/);
  assert.match(block, /if \(!isAdmin\(u\)\)/);
  assert.match(block, /scopeWriteError\(/);
  assert.match(block, /callRpc\("process_bank_transaction"/);
  assert.doesNotMatch(block, /console\.|error\.message/);
  assert.match(migration, /for update/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /data ->> 'bankId' = v_bank_id/);
  assert.match(migration, /'bank:' \|\| p_queue_id/);
  assert.match(migration, /delete from public\.records where entity = 'bankTransactions'/);
  assert.match(migration, /revoke all on function public\.process_bank_transaction\(text, text, text\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.process_bank_transaction[\s\S]*to service_role/);
});

test("ошибка Точки не включает тело банковского ответа", async () => {
  const bank = await source("bank.ts");
  assert.match(bank, /throw new Error\(`Точка API \$\{resp\.status\}`\)/);
  assert.doesNotMatch(bank, /body\.slice|Точка API \$\{resp\.status\}:/);
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
  }
});
