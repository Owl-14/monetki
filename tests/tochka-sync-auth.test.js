import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { LocalStore } from "../js/store.js";
import { tochkaSyncAccess } from "../supabase/functions/api/rules.js";

class MemoryStorage {
  #values = new Map();

  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
  clear() { this.#values.clear(); }
}

globalThis.localStorage = new MemoryStorage();

const cronSecret = "a".repeat(64);
const otherSecret = "b".repeat(64);

test("публичный tochka_sync отклоняется до запуска банковской логики", async () => {
  assert.equal(tochkaSyncAccess(null, null, cronSecret), null);
  assert.equal(tochkaSyncAccess(null, otherSecret, cronSecret), null);

  const apiSource = await readFile(new URL("../supabase/functions/api/index.ts", import.meta.url), "utf8");
  const actionStart = apiSource.indexOf('if (action === "tochka_sync")');
  const actionEnd = apiSource.indexOf('if (action === "migrate_import")', actionStart);
  const actionBlock = apiSource.slice(actionStart, actionEnd);
  const accessAt = actionBlock.indexOf("tochkaSyncAccess(");
  const rejectAt = actionBlock.indexOf('error: "auth"');
  const bankAt = actionBlock.indexOf("runTochkaSync(");

  assert.ok(actionStart >= 0 && actionEnd > actionStart);
  assert.ok(accessAt >= 0 && accessAt < rejectAt);
  assert.ok(rejectAt >= 0 && rejectAt < bankAt);
  assert.match(actionBlock, /error: "auth"\s*\}, 401/);
});

test("активный администратор может вручную вызвать tochka_sync", async () => {
  assert.equal(tochkaSyncAccess({ role: "admin" }, null, cronSecret), "admin");
  assert.equal(tochkaSyncAccess({ role: "staff" }, null, cronSecret), null);

  localStorage.clear();
  const store = new LocalStore();
  const admin = await store.login("111111");
  const employee = await store.login("222222");

  assert.equal((await store.tochkaSync(admin.token, 7)).ok, true);
  assert.deepEqual(await store.tochkaSync(employee.token, 7), { ok: false, error: "auth" });
  assert.deepEqual(await store.tochkaSync("", 7), { ok: false, error: "auth" });
});

test("cron проходит только с отдельным совпадающим секретом", async () => {
  assert.equal(tochkaSyncAccess(null, cronSecret, cronSecret), "cron");
  assert.equal(tochkaSyncAccess({ role: "staff" }, cronSecret, cronSecret), "cron");
  assert.equal(tochkaSyncAccess(null, cronSecret, ""), null);
  assert.equal(tochkaSyncAccess(null, "короткий", "короткий"), null);

  const migration = await readFile(new URL("../supabase/migrations/002_schedule_tochka_sync.sql", import.meta.url), "utf8");
  assert.match(migration, /vault\.decrypted_secrets/);
  assert.match(migration, /'X-Tochka-Sync-Secret'/);
  assert.match(migration, /where name = 'tochka_sync_secret'/);
  assert.doesNotMatch(migration, /TOCHKA_SYNC_SECRET\s*=/);
});

test("банковская синхронизация обнаруживает возможное усечение и ограничивает разбиение", async () => {
  const apiSource = await readFile(new URL("../supabase/functions/api/index.ts", import.meta.url), "utf8");

  assert.match(apiSource, /TOCHKA_STATEMENT_REQUEST_LIMIT\s*=\s*32/);
  assert.match(apiSource, /TOCHKA_STATEMENT_SPLIT_DEPTH\s*=\s*8/);
  assert.match(apiSource, /TOCHKA_SYNC_DEADLINE_MS\s*=\s*150_000/);
  assert.match(apiSource, /collectStatementTransactions\(\{/);
  assert.match(apiSource, /accountRequestLimit\s*=\s*statementRequestBudget\(/);
  assert.doesNotMatch(apiSource, /Math\.floor\(remainingRequests\s*\/\s*remainingAccounts\)/);
  assert.match(apiSource, /statements:\s*\{[\s\S]*split:\s*0,\s*truncated:\s*0/);
  assert.match(apiSource, /if \(i > 0\)[\s\S]*await sleep\(wait\)/);
  assert.match(apiSource, /deadlineReached/);
  assert.match(apiSource, /result\.ok\s*&&\s*result\.outcome\s*!==\s*"partial"/);
  const runStart = apiSource.indexOf("async function runTochkaSync");
  const runEnd = apiSource.indexOf("// ---------- HTTP ----------", runStart);
  const runBlock = apiSource.slice(runStart, runEnd);
  assert.match(runBlock, /error: "Синхронизация с Точка Банком не выполнена"/);
  assert.doesNotMatch(runBlock, /throw\s+error/);
});

test("параллельные запуски защищены атомарной арендой с безопасным перехватом", async () => {
  const apiSource = await readFile(new URL("../supabase/functions/api/index.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/003_tochka_sync_lease.sql", import.meta.url), "utf8");
  const deployWorkflow = await readFile(new URL("../.github/workflows/deploy-backend.yml", import.meta.url), "utf8");
  const applyWorkflow = await readFile(new URL("../.github/workflows/apply-bank-cron-migration.yml", import.meta.url), "utf8");

  assert.match(migration, /create or replace function public\.acquire_tochka_sync_lease/);
  assert.match(migration, /security definer/gi);
  assert.match(migration, /insert into public\.records\(entity, id, data\)[\s\S]*'_locks'[\s\S]*'tochka_sync'/);
  assert.match(migration, /on conflict \(entity, id\) do update[\s\S]*expiresAtEpoch[\s\S]*<= extract\(epoch from v_now\)/);
  assert.match(migration, /clock_timestamp\(\)/);
  assert.match(migration, /delete from public\.records[\s\S]*data ->> 'leaseId' = p_lease_id/);
  assert.match(migration, /revoke all on function public\.acquire_tochka_sync_lease[\s\S]*from public/);
  assert.match(migration, /grant execute on function public\.release_tochka_sync_lease[\s\S]*to service_role/);

  assert.match(apiSource, /TOCHKA_SYNC_LEASE_SECONDS\s*=\s*210/);
  const runStart = apiSource.indexOf("async function runTochkaSync");
  const runEnd = apiSource.indexOf("// ---------- HTTP ----------", runStart);
  const runBlock = apiSource.slice(runStart, runEnd);
  const acquireAt = runBlock.indexOf("acquireTochkaSyncLease(");
  const attemptAt = runBlock.indexOf('kvSet("LAST_SYNC_ATTEMPT"');
  const syncAt = runBlock.indexOf("tochkaSync(");
  const releaseAt = runBlock.indexOf("releaseTochkaSyncLease(leaseId)");
  assert.ok(acquireAt >= 0 && acquireAt < attemptAt && attemptAt < syncAt);
  assert.ok(releaseAt > syncAt);
  assert.match(runBlock, /outcome: "busy"/);
  assert.match(runBlock, /finally\s*\{[\s\S]*if \(leaseId\)[\s\S]*releaseTochkaSyncLease\(leaseId\)/);

  const migrationAt = deployWorkflow.indexOf("003_tochka_sync_lease.sql");
  const deployAt = deployWorkflow.indexOf("supabase functions deploy api");
  assert.ok(migrationAt >= 0 && migrationAt < deployAt);
  assert.match(deployWorkflow, /supabase\/migrations\/003_tochka_sync_lease\.sql/);
  assert.match(applyWorkflow, /002_schedule_tochka_sync\.sql[\s\S]*003_tochka_sync_lease\.sql/);
  assert.match(applyWorkflow, /lease_function_count/);
  assert.doesNotMatch(migration + apiSource, /TOCHKA_SYNC_LEASE_SECRET/);
});

test("workflow ротации использует Management API и не содержит готового секрета", async () => {
  const workflow = await readFile(new URL("../.github/workflows/configure-tochka-sync-secret.yml", import.meta.url), "utf8");

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /concurrency:[\s\S]*group: configure-tochka-sync-secret[\s\S]*cancel-in-progress: false/);
  assert.match(workflow, /extensions\.gen_random_bytes\(32\)/);
  assert.match(workflow, /select decrypted_secret from vault\.decrypted_secrets/);
  const vaultReadBlock = workflow.slice(
    workflow.indexOf('vault_read_status='),
    workflow.indexOf('if [[ "${vault_read_status}"', workflow.indexOf('vault_read_status=')),
  );
  assert.match(vaultReadBlock, /--url "\$\{database_url\}"/);
  assert.doesNotMatch(vaultReadBlock, /\/read-only/);
  assert.doesNotMatch(workflow, /\$\{database_url\}\/read-only/);
  assert.match(workflow, /\/secrets"/);
  assert.match(workflow, /X-Tochka-Sync-Secret: \$\{tochka_sync_secret\}/);
  assert.match(workflow, /\{"action":"tochka_sync","days":30\}/);
  assert.match(workflow, /jq -c '\{added, outcome, diagnostics\}'/);
  assert.doesNotMatch(workflow, /cat\s+"?\$\{sync_response\}/);
  assert.match(workflow, /vault\.(create_secret|update_secret)/);
  assert.match(workflow, /002_schedule_tochka_sync\.sql/);
  assert.match(workflow, /003_tochka_sync_lease\.sql/);
  assert.match(workflow, /lease_function_count/);
  assert.match(workflow, /::add-mask::/);
  assert.doesNotMatch(workflow, /vault\.(create_secret|update_secret)\([^\n]*\$\{tochka_sync_secret\}/);
  assert.doesNotMatch(workflow, /["'][a-f0-9]{64}["']/);
});
