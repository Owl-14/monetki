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
  assert.match(workflow, /vault\.(create_secret|update_secret)/);
  assert.match(workflow, /002_schedule_tochka_sync\.sql/);
  assert.match(workflow, /::add-mask::/);
  assert.doesNotMatch(workflow, /vault\.(create_secret|update_secret)\([^\n]*\$\{tochka_sync_secret\}/);
  assert.doesNotMatch(workflow, /["'][a-f0-9]{64}["']/);
});
