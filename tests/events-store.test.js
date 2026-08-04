import test from "node:test";
import assert from "node:assert/strict";

import { makeStore } from "../js/store.js";

class MemoryStorage {
  #values = new Map();
  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
  clear() { this.#values.clear(); }
}

globalThis.window = { MONETKI_CONFIG: {} };
globalThis.localStorage = new MemoryStorage();

async function context() {
  localStorage.clear();
  const store = makeStore();
  const login = await store.login("111111");
  const initial = await store.bootstrap(login.token);
  const ownerShares = initial.data.businessOwners.filter((owner) => owner.businessId === "padel")
    .map((owner) => ({ ownerId: owner.ownerId, name: owner.name, share: owner.share }));
  const type = await store.create(login.token, "eventTypes", {
    businessId: "padel", unit: "padel", name: "Турнир", active: true,
    defaultFee: 100, staffRate: 15, ownerShares,
  });
  assert.equal(type.ok, true);
  const event = await store.create(login.token, "events", {
    businessId: "padel", unit: "padel", eventTypeId: type.item.id, title: "Кубок",
    startsAt: "2026-08-04T12:00", status: "planned", settlementStatus: "open",
    defaultFee: 100, capacity: 1,
  });
  assert.equal(event.ok, true);
  assert.equal(event.item.settlementStatus, "open");
  assert.equal(event.item.settlement, undefined);
  const registration = await store.create(login.token, "eventRegistrations", {
    businessId: "padel", unit: "padel", eventId: event.item.id,
    participantType: "player", participantId: initial.data.players[0].id,
    status: "confirmed", chargeAmount: 100,
  });
  assert.equal(registration.ok, true);
  const finance = await store.create(login.token, "finance", {
    businessId: "padel", unit: "padel", type: "income", amount: 100.01, date: "2026-08-04", category: "Взнос",
  });
  assert.equal(finance.ok, true);
  return { store, token: login.token, type: type.item, event: event.item, registration: registration.item, finance: finance.item };
}

test("демо не подменяет историю фиктивными событиями", async () => {
  localStorage.clear();
  const store = makeStore();
  const login = await store.login("111111");
  const bootstrap = await store.bootstrap(login.token);
  assert.deepEqual(bootstrap.data.eventTypes, []);
  assert.deepEqual(bootstrap.data.events, []);
  assert.deepEqual(bootstrap.data.eventRegistrations, []);
  assert.deepEqual(bootstrap.data.eventBudgetLines, []);
  assert.deepEqual(bootstrap.data.eventFinanceAllocations, []);
});

test("LocalStore создаёт идемпотентную неизменяемую финансовую связь и не допускает перераспределение", async () => {
  const { store, token, event, registration, finance } = await context();
  const item = {
    businessId: "padel", unit: "padel", eventId: event.id, financeId: finance.id, registrationId: registration.id,
    purpose: "payment", amount: 100.01, idempotencyKey: "payment:stable-001",
  };
  const first = await store.allocateEventFinance(token, item);
  const retry = await store.allocateEventFinance(token, item);
  assert.equal(first.ok, true);
  assert.equal(retry.ok, true);
  assert.equal(retry.alreadyAllocated, true);
  assert.equal(retry.item.id, first.item.id);

  const over = await store.allocateEventFinance(token, { ...item, amount: 0.01, idempotencyKey: "payment:stable-002" });
  assert.equal(over.ok, false);
  assert.match(over.error, /больше суммы/);
  assert.equal((await store.update(token, "eventFinanceAllocations", { ...first.item, amount: 1 })).ok, false);
  assert.equal((await store.remove(token, "eventFinanceAllocations", first.item.id)).ok, false);
  assert.equal((await store.update(token, "finance", { ...finance, amount: 200 })).ok, false);
});

test("расчёт закрывается отдельно от статуса события и после этого не переписывается", async () => {
  const { store, token, event, registration, finance } = await context();
  await store.allocateEventFinance(token, {
    businessId: "padel", unit: "padel", eventId: event.id, financeId: finance.id, registrationId: registration.id,
    purpose: "payment", amount: 100.01, idempotencyKey: "settlement:payment-001",
  });
  assert.equal((await store.closeEventSettlement(token, event.id)).ok, false);
  const completed = await store.update(token, "events", { ...event, status: "completed" });
  assert.equal(completed.ok, true);
  assert.equal(completed.item.settlementStatus, "open");

  const closed = await store.closeEventSettlement(token, event.id);
  const retry = await store.closeEventSettlement(token, event.id);
  assert.equal(closed.ok, true);
  assert.equal(closed.item.settlementStatus, "closed");
  assert.equal(closed.item.settlement.profit, 100.01);
  assert.equal(closed.item.history.at(-1).action, "settlement_closed");
  assert.equal(retry.alreadyClosed, true);
  assert.equal((await store.update(token, "events", { ...closed.item, title: "Переписано" })).ok, false);
});

test("модуль events обязателен и специальная финансовая операция закрыта сотруднику", async () => {
  const { store, event, finance } = await context();
  const staffLogin = await store.login("222222");
  const allocation = await store.allocateEventFinance(staffLogin.token, {
    businessId: "padel", unit: "padel", eventId: event.id, financeId: finance.id,
    purpose: "payment", amount: 1, idempotencyKey: "staff:payment-001",
  });
  assert.equal(allocation.ok, false);
  assert.equal(allocation.error, "Только для админа");

  const devEvent = await store.create(staffLogin.token, "events", {
    businessId: "dev", unit: "dev", eventTypeId: "missing", title: "Чужое",
    startsAt: "2026-08-04T12:00", status: "planned", settlementStatus: "open", defaultFee: 0, capacity: 0,
  });
  assert.equal(devEvent.ok, false);

  const adminLogin = await store.login("111111");
  const moduleOff = await store.create(adminLogin.token, "events", {
    businessId: "dev", unit: "dev", eventTypeId: "missing", title: "Без модуля",
    startsAt: "2026-08-04T12:00", status: "planned", settlementStatus: "open", defaultFee: 0, capacity: 0,
  });
  assert.equal(moduleOff.ok, false);
  assert.equal(moduleOff.error, "Модуль «События» выключен для этого бизнеса");
});

test("клиент не может заранее закрыть расчёт или подменить системный итог", async () => {
  const { store, token, type, event } = await context();
  const created = await store.create(token, "events", {
    businessId: "padel", unit: "padel", eventTypeId: type.id, title: "Подмена",
    startsAt: "2026-08-05T12:00", status: "completed", settlementStatus: "closed",
    settlement: { profit: 999 }, settlementClosedAt: 1, completedAt: 1, defaultFee: 0, capacity: 0,
  });
  assert.equal(created.ok, true);
  assert.equal(created.item.settlementStatus, "open");
  assert.equal(created.item.settlement, undefined);
  const changed = await store.update(token, "events", { ...event, settlement: { profit: 999 } });
  assert.equal(changed.ok, false);
  assert.match(changed.error, /Системные итоги/);
});

test("сотрудник не видит и не подменяет финансовые поля и управляет только своим событием", async () => {
  const { store, token, type, event } = await context();
  const staffLogin = await store.login("222222");
  const created = await store.create(staffLogin.token, "events", {
    businessId: "padel", unit: "padel", eventTypeId: type.id, title: "Своё событие",
    startsAt: "2026-08-06T12:00", status: "planned", defaultFee: 999999,
    responsibleId: "admin", capacity: 2, staffAmount: 999999, staffRate: 999999,
    ownerShares: [{ ownerId: "staff", share: 1 }], chargeAmount: 999999,
  });
  assert.equal(created.ok, true);
  assert.equal(created.item.defaultFee, undefined);
  assert.equal(created.item.staffAmount, 0);

  const adminBackup = await store.backup(token);
  const raw = adminBackup.data.events.find((item) => item.id === created.item.id);
  assert.equal(raw.defaultFee, 100);
  assert.equal(raw.responsibleId, staffLogin.profile.id);
  assert.equal(raw.staffAmount, undefined);
  assert.equal(raw.staffRate, undefined);
  assert.equal(raw.ownerShares, undefined);
  assert.equal(raw.chargeAmount, undefined);

  const participantId = adminBackup.data.players[0].id;
  const registration = await store.create(staffLogin.token, "eventRegistrations", {
    businessId: "padel", unit: "padel", eventId: raw.id,
    participantType: "player", participantId, status: "confirmed", chargeAmount: 999999,
    defaultFee: 999999, staffRate: 999999, ownerShares: [{ ownerId: "staff", share: 1 }],
  });
  assert.equal(registration.ok, true);
  assert.equal(registration.item.chargeAmount, undefined);
  const afterRegistration = await store.backup(token);
  const rawRegistration = afterRegistration.data.eventRegistrations.find((item) => item.id === registration.item.id);
  assert.equal(rawRegistration.chargeAmount, 100);
  assert.equal(rawRegistration.defaultFee, undefined);
  assert.equal(rawRegistration.staffRate, undefined);
  assert.equal(rawRegistration.ownerShares, undefined);

  assert.equal((await store.update(staffLogin.token, "events", { id: raw.id, defaultFee: 1 })).ok, false);
  assert.equal((await store.update(staffLogin.token, "eventRegistrations", { id: registration.item.id, chargeAmount: 1 })).ok, false);
  assert.equal((await store.update(staffLogin.token, "events", { id: event.id, title: "Чужое" })).ok, false);
  assert.equal((await store.remove(staffLogin.token, "events", event.id)).ok, false);
});

test("закрытое начисление сотрудника не меняется после изменения типа", async () => {
  const { store, token, type, event } = await context();
  const staffLogin = await store.login("222222");
  await store.update(token, "events", { id: event.id, responsibleId: staffLogin.profile.id, status: "completed" });
  const closed = await store.closeEventSettlement(token, event.id);
  assert.equal(closed.item.settlement.staffRate, 15);
  assert.equal(closed.item.settlement.staffAmount, 15);
  await store.update(token, "eventTypes", { ...type, staffRate: 999 });
  const staffView = await store.bootstrap(staffLogin.token);
  const visible = staffView.data.events.find((item) => item.id === event.id);
  assert.equal(visible.staffAmount, 15);
  assert.equal(staffView.data.eventTypes[0].staffRate, undefined);
});

test("админская копия сохраняет события архивного бизнеса и повторно восстанавливается без переписывания истории", async () => {
  const { store, token, event } = await context();
  const archived = await store.update(token, "businesses", { id: "padel", active: false, modules: [] });
  assert.equal(archived.ok, true);
  const ordinary = await store.bootstrap(token);
  assert.equal(ordinary.data.events.some((item) => item.id === event.id), false);
  const backup = await store.backup(token);
  assert.equal(backup.data.events.some((item) => item.id === event.id), true);
  assert.ok(Array.isArray(backup.data.files));

  const first = await store.migrateImport(token, backup.data);
  const retry = await store.migrateImport(token, backup.data);
  assert.equal(first.ok, true);
  assert.equal(retry.ok, true);
  const conflict = structuredClone(backup.data);
  conflict.events = conflict.events.map((item) => item.id === event.id ? { ...item, title: "Тихая подмена" } : item);
  assert.equal((await store.migrateImport(token, conflict)).ok, false);
  assert.equal((await store.backup(token)).data.events.find((item) => item.id === event.id).title, event.title);
});

test("нельзя удалить участника или площадку, которые нужны истории события", async () => {
  const { store, token, event, registration } = await context();
  const backup = await store.backup(token);
  const player = backup.data.players.find((item) => item.id === registration.participantId);
  assert.equal((await store.remove(token, "players", player.id)).ok, false);
  const venue = backup.data.venues[0];
  await store.update(token, "events", { id: event.id, venueId: venue.id });
  assert.equal((await store.remove(token, "venues", venue.id)).ok, false);
});
