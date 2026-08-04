import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { DEFAULT_BUSINESSES, DEFAULT_BUSINESS_OWNERS, makeStore } from "../js/store.js";
import {
  accessSet,
  businessIdOf,
  bootstrapBusinessIds,
  checkWriteAccess,
  defaultCrmPipeline,
  defaultCrmStages,
  scopeWriteError,
  validateCoreEntity,
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
  adminOther: { id: "admin-other", name: "Второй админ", code: "111112", role: "admin", unit: "all", phone: "5", tg: "@admin-other", active: true },
  padel: { id: "padel-a", name: "Падел А", code: "222222", role: "staff", unit: "padel", phone: "2", tg: "@padel", active: true },
  padelOther: { id: "padel-b", name: "Падел Б", code: "222223", role: "staff", unit: "padel", phone: "3", tg: "@padel-b", active: true },
  dev: { id: "dev-a", name: "Dev А", code: "333333", role: "staff", unit: "dev", phone: "4", tg: "@dev", active: true },
};

function fixture() {
  return {
    businesses: DEFAULT_BUSINESSES.map((business) => ({ ...business, modules: [...business.modules] })),
    memberships: [
      { id: "m-admin-padel", employeeId: "admin", businessId: "padel", unit: "padel", role: "owner", active: true },
      { id: "m-admin-dev", employeeId: "admin", businessId: "dev", unit: "dev", role: "owner", active: true },
      { id: "m-admin-other-padel", employeeId: "admin-other", businessId: "padel", unit: "padel", role: "owner", active: true },
      { id: "m-admin-other-dev", employeeId: "admin-other", businessId: "dev", unit: "dev", role: "owner", active: true },
      { id: "m-padel-a", employeeId: "padel-a", businessId: "padel", unit: "padel", role: "staff", active: true },
      { id: "m-padel-b", employeeId: "padel-b", businessId: "padel", unit: "padel", role: "staff", active: true },
      { id: "m-dev-a", employeeId: "dev-a", businessId: "dev", unit: "dev", role: "staff", active: true },
    ],
    businessOwners: DEFAULT_BUSINESS_OWNERS.map((owner) => ({ ...owner })),
    employees: Object.values(users),
    clients: [
      { id: "client-padel", businessId: "padel", unit: "padel" },
      { id: "client-dev", businessId: "dev", unit: "dev" },
    ],
    companies: [],
    contacts: [],
    leads: [],
    deals: [],
    pipelines: [defaultCrmPipeline("dev")],
    stages: defaultCrmStages("dev"),
    dealItems: [],
    venues: [{ id: "venue-padel", businessId: "padel", unit: "padel" }],
    players: [{ id: "player-padel", businessId: "padel", unit: "padel" }],
    tasks: [
      { id: "task-padel-a", businessId: "padel", unit: "padel", assigneeId: "padel-a", authorId: "admin", title: "От админа", status: "new" },
      { id: "task-padel-b", businessId: "padel", unit: "padel", assigneeId: "padel-b", authorId: "padel-b", title: "Чужая", status: "new" },
      { id: "task-dev-a", businessId: "dev", unit: "dev", assigneeId: "dev-a", authorId: "dev-a", title: "Dev", status: "new" },
    ],
    finance: [
      { id: "finance-padel-a", businessId: "padel", unit: "padel", employeeId: "padel-a" },
      { id: "finance-dev-a", businessId: "dev", unit: "dev", employeeId: "dev-a" },
      { id: "finance-general", businessId: "padel", unit: "padel" },
    ],
    staffExpenses: [
      { id: "expense-padel-a", businessId: "padel", unit: "padel", employeeId: "padel-a", status: "pending" },
      { id: "expense-dev-a", businessId: "dev", unit: "dev", employeeId: "dev-a", status: "pending" },
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

test("демо-коды 111111, 222222 и 333333 входят с ожидаемой изоляцией", async () => {
  localStorage.clear();
  const store = makeStore();
  for (const [code, expectedBusinesses, expectedTasks] of [
    ["111111", ["padel", "dev"], 4],
    ["222222", ["padel"], 2],
    ["333333", ["dev"], 1],
  ]) {
    const login = await store.login(code);
    assert.equal(login.ok, true);
    const bootstrap = await store.bootstrap(login.token);
    assert.deepEqual(bootstrap.data.businesses.map((business) => business.id), expectedBusinesses);
    assert.equal(bootstrap.data.tasks.length, expectedTasks);
  }
});

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
  assert.equal(checkWriteAccess(users.padel, "tasks", { unit: "dev" }), "Нет доступа к этому бизнесу");
  assert.equal(checkWriteAccess(users.admin, "finance", { unit: "dev" }), null);
});

test("трата сотрудника использует активный membership, а не legacy unit", async () => {
  const data = fixture();
  data.memberships.push({
    id: "m-dev-a-padel", employeeId: "dev-a", businessId: "padel", unit: "padel", role: "staff", active: true,
  });
  const item = { businessId: "padel", amount: 100, title: "Падел-трата", receiptId: "receipt-dev-padel" };

  assert.equal(checkWriteAccess(users.dev, "staffExpenses", item, data.memberships), null);
  const local = await localStoreWith(data).create("demo:dev-a", "staffExpenses", item);

  assert.equal(local.ok, true);
  assert.equal(local.item.businessId, "padel");
  assert.equal(local.item.unit, "padel");
  assert.equal(local.item.employeeId, "dev-a");
});

test("businessId имеет приоритет чтения, но несовпадающая пара отклоняется", () => {
  assert.equal(businessIdOf({ businessId: "dev", unit: "padel" }), "dev");
  const access = accessSet(fixture().memberships, users.admin.id);
  assert.equal(scopeWriteError(access, { businessId: "dev", unit: "padel" }), "businessId и unit должны совпадать");
});

test("update проверяет исходный и целевой бизнес до изменения задачи", async () => {
  const store = localStoreWith(fixture());
  const moved = await store.update("demo:padel-a", "tasks", {
    id: "task-padel-a", businessId: "dev", unit: "dev", status: "done",
  });
  assert.equal(moved.ok, false);
  assert.equal(moved.error, "Нет доступа к этому бизнесу");

  const unchanged = await store.bootstrap("demo:padel-a");
  assert.equal(unchanged.data.tasks[0].status, "new");
  assert.equal(unchanged.data.tasks[0].businessId, "padel");
});

test("отключённый membership закрывает bootstrap и новые записи бизнеса", async () => {
  const store = localStoreWith(fixture());
  const disabled = await store.update("demo:admin", "memberships", {
    ...fixture().memberships.find((membership) => membership.id === "m-padel-a"),
    active: false,
  });
  assert.equal(disabled.ok, true);

  const bootstrap = await store.bootstrap("demo:padel-a");
  assert.deepEqual(bootstrap.data.businesses, []);
  assert.deepEqual(bootstrap.data.tasks, []);

  const created = await store.create("demo:padel-a", "tasks", { businessId: "padel", unit: "padel", title: "Нет доступа" });
  assert.equal(created.ok, false);
  assert.equal(created.error, "Нет доступа к этому бизнесу");
});

test("новый активный бизнес автоматически доступен всем активным админам как owner", async () => {
  assert.deepEqual(
    bootstrapBusinessIds(users.adminOther, [...fixture().businesses, { id: "events", active: true }]),
    ["padel", "dev", "events"],
  );
  const store = localStoreWith(fixture());
  const created = await store.create("demo:admin", "businesses", {
    id: "events", name: "События", emoji: "📅", modules: ["dashboard"], active: true,
  });
  assert.equal(created.ok, true);

  const secondAdmin = await store.bootstrap("demo:admin-other");
  assert.equal(secondAdmin.data.businesses.some((business) => business.id === "events"), true);
  const membership = secondAdmin.data.memberships.find((item) => item.employeeId === "admin-other" && businessIdOf(item) === "events");
  assert.equal(membership.role, "owner");
  assert.equal(membership.active, true);
  const creatorShare = secondAdmin.data.businessOwners.find((item) => item.ownerId === "admin" && businessIdOf(item) === "events");
  assert.equal(creatorShare.share, 1);
  assert.equal(creatorShare.name, "Админ");
});

test("архив бизнеса скрывает рабочие данные, сохраняет их и позволяет восстановление", async () => {
  const store = localStoreWith(fixture());
  const created = await store.create("demo:admin", "businesses", {
    id: "events", name: "События", emoji: "📅", modules: ["dashboard", "tasks"], active: true,
  });
  assert.equal(created.ok, true);
  assert.equal(
    (await store.bootstrap("demo:admin")).data.memberships.some((item) =>
      item.employeeId === "admin" && businessIdOf(item) === "events" && item.role === "owner"
    ),
    true,
  );

  assert.equal((await store.create("demo:admin", "memberships", {
    businessId: "events", unit: "events", employeeId: "padel-a", role: "staff", active: true,
  })).ok, true);
  const createdTask = await store.create("demo:admin", "tasks", {
    businessId: "events", unit: "events", assigneeId: "padel-a", title: "Подготовить событие", status: "new",
  });
  assert.equal(createdTask.ok, true);

  assert.equal((await store.update("demo:admin", "businesses", { ...created.item, active: false })).ok, true);
  const adminArchived = await store.bootstrap("demo:admin");
  const staffArchived = await store.bootstrap("demo:padel-a");
  assert.equal(adminArchived.data.businesses.find((item) => item.id === "events")?.active, false);
  assert.equal(adminArchived.data.tasks.some((item) => businessIdOf(item) === "events"), false);
  assert.equal(staffArchived.data.businesses.some((item) => item.id === "events"), false);
  assert.equal(staffArchived.data.tasks.some((item) => businessIdOf(item) === "events"), false);

  const blocked = await store.create("demo:admin", "tasks", {
    businessId: "events", unit: "events", title: "Нельзя записать в архив",
  });
  assert.equal(blocked.error, "Бизнес в архиве");
  assert.equal(
    (await store.addComment("demo:admin", createdTask.item.id, "Скрытый комментарий")).error,
    "Бизнес в архиве",
  );

  assert.equal((await store.update("demo:admin", "businesses", { ...created.item, active: true })).ok, true);
  const restored = await store.bootstrap("demo:padel-a");
  assert.equal(restored.data.businesses.some((item) => item.id === "events"), true);
  assert.equal(restored.data.tasks.some((item) => item.title === "Подготовить событие"), true);
});

test("специальные действия не записывают данные в архивный бизнес", async () => {
  const store = localStoreWith(fixture());
  const padel = (await store.bootstrap("demo:admin")).data.businesses.find((item) => item.id === "padel");
  assert.equal((await store.update("demo:admin", "businesses", { ...padel, active: false })).ok, true);
  assert.equal(
    (await store.addComment("demo:admin", "task-padel-a", "Комментарий в архив")).error,
    "Бизнес в архиве",
  );
  assert.equal(
    (await store.importPlayers("demo:admin", [{ name: "Новый игрок" }])).error,
    "Бизнес в архиве",
  );

  const apiSource = await readFile(new URL("../supabase/functions/api/actions.ts", import.meta.url), "utf8");
  const commentBlock = apiSource.slice(apiSource.indexOf("async function addComment"), apiSource.indexOf("async function importPlayers"));
  const importBlock = apiSource.slice(apiSource.indexOf("async function importPlayers"), apiSource.indexOf("async function markRead"));
  assert.match(commentBlock, /scopeWriteError\(access, task, businesses\)/);
  assert.match(importBlock, /business\.id === "padel" && business\.active !== false/);
});

test("delete бизнеса работает как архив и не освобождает его ID", async () => {
  const store = localStoreWith(fixture());
  const business = { id: "events", name: "События", emoji: "📅", modules: ["dashboard"], active: true };
  assert.equal((await store.create("demo:admin", "businesses", business)).ok, true);
  const removed = await store.remove("demo:admin", "businesses", "events");
  assert.equal(removed.ok, true);
  assert.equal(removed.item.active, false);
  assert.equal((await store.bootstrap("demo:admin")).data.businesses.find((item) => item.id === "events")?.active, false);
  assert.equal((await store.create("demo:admin", "businesses", business)).error, "Бизнес с таким ID уже существует");
});

test("API rules скрывают записи архива и запрещают запись так же, как LocalStore", () => {
  const data = fixture();
  data.businesses.push({ id: "events", name: "События", modules: ["tasks"], active: false });
  data.memberships.push(
    { id: "m-admin-events", employeeId: "admin", businessId: "events", unit: "events", role: "owner", active: true },
    { id: "m-padel-events", employeeId: "padel-a", businessId: "events", unit: "events", role: "staff", active: true },
  );
  data.tasks.push({ id: "task-events", businessId: "events", unit: "events", assigneeId: "padel-a" });

  const admin = visibleBootstrapData(users.admin, data);
  const staff = visibleBootstrapData(users.padel, data);
  assert.equal(admin.businesses.find((item) => item.id === "events")?.active, false);
  assert.equal(admin.tasks.some((item) => item.id === "task-events"), false);
  assert.equal(staff.businesses.some((item) => item.id === "events"), false);
  assert.equal(staff.tasks.some((item) => item.id === "task-events"), false);
  assert.equal(
    scopeWriteError(accessSet(data.memberships, users.admin.id), { businessId: "events", unit: "events" }, data.businesses),
    "Бизнес в архиве",
  );
});

test("валидация CORE симметрично отклоняет небезопасные и ссылочно неверные записи", async () => {
  const cases = [
    ["businesses", { id: "all", name: "Нельзя" }, "ID бизнеса должен быть безопасным slug"],
    ["businesses", { id: "personal", name: "Нельзя" }, "ID бизнеса должен быть безопасным slug"],
    ["businesses", { id: "total", name: "Нельзя" }, "ID бизнеса должен быть безопасным slug"],
    ["businesses", { id: "dev", name: "Дубль" }, "Бизнес с таким ID уже существует"],
    ["businesses", { id: "empty", name: "", modules: [], active: true }, "Не указано название бизнеса"],
    ["businesses", { id: "modules", name: "Модули", modules: "tasks", active: true }, "Модули бизнеса должны быть списком"],
    ["businesses", { id: "status", name: "Статус", modules: [], active: "yes" }, "Статус бизнеса должен быть логическим"],
    ["memberships", { businessId: "missing", unit: "missing", employeeId: "padel-a", role: "staff" }, "Бизнес не найден"],
    ["memberships", { businessId: "dev", unit: "dev", employeeId: "missing", role: "staff" }, "Сотрудник не найден"],
    ["memberships", { businessId: "dev", unit: "dev", employeeId: "padel-a", role: "admin" }, "Неизвестная роль доступа"],
    ["memberships", { businessId: "padel", unit: "padel", employeeId: "padel-a", role: "staff" }, "Доступ сотрудника к этому бизнесу уже существует"],
    ["businessOwners", { businessId: "dev", unit: "dev", ownerId: "new-owner", share: 2 }, "Доля должна быть числом от 0 до 1"],
  ];

  for (const [entity, item, expected] of cases) {
    const data = fixture();
    assert.equal(validateCoreEntity(entity, item, data), expected);
    const store = localStoreWith(data);
    const local = await store.create("demo:admin", entity, item);
    assert.equal(local.error, expected);
  }

  const validStore = localStoreWith(fixture());
  const manager = await validStore.create("demo:admin", "memberships", {
    businessId: "dev", unit: "dev", employeeId: "padel-a", role: "manager", active: true,
  });
  assert.equal(manager.ok, true);
});

test("админская форма сохраняет роль manager отдельным вариантом", async () => {
  const appSource = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(appSource, /option value="manager"[^>]*membership\?\.role === 'manager'/);
  assert.match(appSource, /!\['owner', 'manager'\]\.includes\(membership\?\.role\)/);
});

test("неверный серверный login отклоняется до CORE bootstrap", async () => {
  const apiSource = await readFile(new URL("../supabase/functions/api/http.ts", import.meta.url), "utf8");
  const loginStart = apiSource.indexOf('if (action === "login")');
  const loginEnd = apiSource.indexOf('if (action === "status")', loginStart);
  const loginBlock = apiSource.slice(loginStart, loginEnd);
  const findUserAt = loginBlock.indexOf("findUser(body.code)");
  const rejectAt = loginBlock.indexOf("if (!u)");
  const ensureAt = loginBlock.indexOf("await ensureCoreData()");

  assert.ok(loginStart >= 0 && loginEnd > loginStart);
  assert.ok(findUserAt >= 0 && findUserAt < rejectAt);
  assert.ok(rejectAt >= 0 && rejectAt < ensureAt);
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
