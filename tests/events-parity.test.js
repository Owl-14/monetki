import test from "node:test";
import assert from "node:assert/strict";

import { makeStore } from "../js/store.js";
import { visibleBootstrapData } from "../supabase/functions/api/rules.js";

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

test("bootstrap событий совпадает у LocalStore и Supabase для сотрудника", async () => {
  localStorage.clear();
  let store = makeStore();
  const login = await store.login("222222");
  const db = JSON.parse(localStorage.getItem(DB_KEY));
  db.eventTypes.push({ id: "type", businessId: "padel", unit: "padel", name: "Турнир", active: true, defaultFee: 100, staffRate: 15, ownerShares: [{ ownerId: "savva", share: 1 }] });
  db.events.push({ id: "event", businessId: "padel", unit: "padel", eventTypeId: "type", title: "Событие", status: "completed", settlementStatus: "closed", settlement: { profit: 999, staffRate: 15, staffAmount: 15 }, startsAt: "2026-08-04T12:00:00.000Z", defaultFee: 100, capacity: 1, responsibleId: login.profile.id, history: [] });
  db.eventRegistrations.push({ id: "registration", businessId: "padel", unit: "padel", eventId: "event", participantType: "player", participantId: db.players[0].id, status: "confirmed", chargeAmount: 100 });
  db.eventBudgetLines.push({ id: "budget", businessId: "padel", unit: "padel", eventId: "event", name: "Доход", direction: "income", plannedAmount: 100 });
  db.eventFinanceAllocations.push({ id: "allocation", businessId: "padel", unit: "padel", eventId: "event", financeId: db.finance[0].id, purpose: "payment", amount: 10, idempotencyKey: "parity:payment-001" });
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  store = makeStore();

  const local = await store.bootstrap(login.token);
  const normalizedDb = JSON.parse(localStorage.getItem(DB_KEY));
  const user = normalizedDb.employees.find((employee) => employee.id === login.profile.id);
  const server = visibleBootstrapData(user, normalizedDb, local.data.bankBalance);
  for (const entity of ["eventTypes", "events", "eventRegistrations", "eventBudgetLines", "eventFinanceAllocations"]) {
    assert.deepEqual(local.data[entity], server[entity], entity);
  }
  assert.equal(local.data.eventTypes[0].ownerShares, undefined);
  assert.equal(local.data.eventTypes[0].defaultFee, undefined);
  assert.equal(local.data.eventTypes[0].staffRate, undefined);
  assert.equal(local.data.events[0].defaultFee, undefined);
  assert.equal(local.data.events[0].settlement, undefined);
  assert.equal(local.data.events[0].staffAmount, 15);
  assert.equal(local.data.eventRegistrations[0].chargeAmount, undefined);
  assert.deepEqual(local.data.eventBudgetLines, []);
  assert.deepEqual(local.data.eventFinanceAllocations, []);
});
