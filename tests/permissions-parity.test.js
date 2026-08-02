import test from "node:test";
import assert from "node:assert/strict";

import { makeStore } from "../js/store.js";
import {
  checkWriteAccess,
  visibleBootstrapData,
} from "../supabase/functions/api/rules.js";

class MemoryStorage {
  #values = new Map();

  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
  clear() { this.#values.clear(); }
}

globalThis.window = { MONETKI_CONFIG: {} };
globalThis.localStorage = new MemoryStorage();

const DB_KEY = "monetki_demo_db";
const users = {
  admin: { id: "admin", name: "Админ", code: "111111", role: "admin", unit: "all", phone: "1", tg: "@admin", active: true },
  padel: { id: "padel-a", name: "Падел А", code: "222222", role: "staff", unit: "padel", phone: "2", tg: "@padel", active: true },
  padelOther: { id: "padel-b", name: "Падел Б", code: "222223", role: "staff", unit: "padel", phone: "3", tg: "@padel-b", active: true },
  dev: { id: "dev-a", name: "Dev А", code: "333333", role: "staff", unit: "dev", phone: "4", tg: "@dev", active: true },
};

function fixture() {
  return {
    employees: Object.values(users),
    clients: [
      { id: "client-padel", unit: "padel" },
      { id: "client-dev", unit: "dev" },
    ],
    venues: [{ id: "venue-padel", unit: "padel" }],
    players: [{ id: "player-padel", unit: "padel" }],
    tasks: [
      { id: "task-padel-a", unit: "padel", assigneeId: "padel-a", authorId: "admin", title: "От админа", status: "new" },
      { id: "task-padel-b", unit: "padel", assigneeId: "padel-b", authorId: "padel-b", title: "Чужая", status: "new" },
      { id: "task-dev-a", unit: "dev", assigneeId: "dev-a", authorId: "dev-a", title: "Dev", status: "new" },
    ],
    finance: [
      { id: "finance-padel-a", unit: "padel", employeeId: "padel-a" },
      { id: "finance-dev-a", unit: "dev", employeeId: "dev-a" },
      { id: "finance-general", unit: "padel" },
    ],
    staffExpenses: [
      { id: "expense-padel-a", unit: "padel", employeeId: "padel-a", status: "pending" },
      { id: "expense-dev-a", unit: "dev", employeeId: "dev-a", status: "pending" },
    ],
    cash: [
      { id: "cash-padel-a", employeeId: "padel-a" },
      { id: "cash-owner-only", owner: "savva" },
    ],
    files: [],
    notifications: [
      { id: "notification-padel-a", toId: "padel-a" },
      { id: "notification-dev-a", toId: "dev-a" },
    ],
  };
}

function localStoreWith(data) {
  localStorage.clear();
  localStorage.setItem(DB_KEY, JSON.stringify(data));
  return makeStore();
}

for (const user of [users.admin, users.padel, users.dev]) {
  test(`bootstrap LocalStore и API совпадает для ${user.role}/${user.unit}`, async () => {
    const data = fixture();
    const store = localStoreWith(data);
    const local = await store.bootstrap(`demo:${user.id}`);
    assert.equal(local.ok, true);

    const server = visibleBootstrapData(user, data, local.data.bankBalance);
    assert.deepEqual(local.data, server);
  });
}

test("сотрудник видит только свои задачи и выплаты, без секретных полей коллег", async () => {
  const store = localStoreWith(fixture());
  const result = await store.bootstrap("demo:padel-a");

  assert.deepEqual(result.data.tasks.map((item) => item.id), ["task-padel-a"]);
  assert.deepEqual(result.data.finance.map((item) => item.id), ["finance-padel-a"]);
  assert.deepEqual(result.data.cash.map((item) => item.id), ["cash-padel-a"]);
  assert.equal(result.data.bankBalance, null);
  assert.equal(result.data.employees.some((employee) => "code" in employee), false);
  assert.equal(result.data.clients.some((item) => item.unit === "dev"), false);
});

test("админ видит все задачи и финансовые записи", async () => {
  const store = localStoreWith(fixture());
  const result = await store.bootstrap("demo:admin");

  assert.equal(result.data.tasks.length, 3);
  assert.equal(result.data.finance.length, 3);
  assert.equal(result.data.cash.length, 2);
  assert.deepEqual(result.data.bankBalance.amount, 175_000);
});

test("запись финансов закрыта сотруднику и на LocalStore, и в API", async () => {
  const store = localStoreWith(fixture());
  const local = await store.create("demo:padel-a", "finance", { unit: "padel", amount: 100 });

  assert.equal(local.ok, false);
  assert.equal(checkWriteAccess(users.padel, "finance", { unit: "padel" }), "Только для админа");
  assert.equal(checkWriteAccess(users.padel, "tasks", { unit: "dev" }), "Нет доступа к этому направлению");
  assert.equal(checkWriteAccess(users.admin, "finance", { unit: "dev" }), null);
});

test("сотрудник создаёт задачу только себе, а в задаче админа меняет только статус", async () => {
  const store = localStoreWith(fixture());
  const created = await store.create("demo:padel-a", "tasks", {
    unit: "padel",
    title: "Новая",
    status: "new",
    assigneeId: "padel-b",
    authorId: "padel-a",
  });
  assert.equal(created.item.assigneeId, "padel-a");

  const updated = await store.update("demo:padel-a", "tasks", {
    id: "task-padel-a",
    title: "Подмена",
    status: "done",
    assigneeId: "dev-a",
  });
  assert.equal(updated.item.title, "От админа");
  assert.equal(updated.item.assigneeId, "padel-a");
  assert.equal(updated.item.status, "done");

  const removed = await store.remove("demo:padel-a", "tasks", "task-padel-a");
  assert.equal(removed.ok, false);
});
