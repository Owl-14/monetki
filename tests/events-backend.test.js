import test from "node:test";
import assert from "node:assert/strict";

import {
  BUSINESS_SCOPED_ENTITIES,
  ENTITIES,
  baseWriteError,
  visibleBootstrapData,
} from "../supabase/functions/api/rules.js";
import {
  EVENT_ENTITIES,
  eventDeleteError,
  eventEconomy,
  eventModuleWriteError,
  eventRecordError,
  eventSettlementSnapshot,
} from "../supabase/functions/api/event-rules.js";

const admin = { id: "admin", name: "Админ", role: "admin", unit: "all", active: true };
const staff = { id: "staff", name: "Сотрудник", role: "staff", unit: "padel", active: true };

function fixture() {
  return {
    businesses: [
      { id: "padel", name: "Падел", active: true, modules: ["events"] },
      { id: "dev", name: "Разработка", active: true, modules: [] },
    ],
    memberships: [
      { id: "m-admin", employeeId: "admin", businessId: "padel", unit: "padel", role: "owner", active: true },
      { id: "m-staff", employeeId: "staff", businessId: "padel", unit: "padel", role: "staff", active: true },
    ],
    businessOwners: [
      { id: "o1", businessId: "padel", unit: "padel", ownerId: "one", name: "Первый", share: 0.33, active: true },
      { id: "o2", businessId: "padel", unit: "padel", ownerId: "two", name: "Второй", share: 0.34, active: true },
      { id: "o3", businessId: "padel", unit: "padel", ownerId: "three", name: "Третий", share: 0.33, active: true },
    ],
    employees: [admin, staff],
    clients: [], companies: [], contacts: [{ id: "contact", businessId: "padel", unit: "padel", name: "Контакт" }], leads: [], deals: [], pipelines: [], stages: [], dealItems: [],
    venues: [{ id: "venue", businessId: "padel", unit: "padel", name: "Зал" }],
    players: [{ id: "player", businessId: "padel", unit: "padel", name: "Игрок" }],
    tasks: [], staffExpenses: [], cash: [], files: [], notifications: [], bankTransactions: [],
    warehouses: [], stockItems: [], stockMovements: [], stockBalances: [], reservations: [], inventories: [],
    eventTypes: [{
      id: "type", businessId: "padel", unit: "padel", name: "Турнир", active: true,
      defaultFee: 50, staffRate: 10,
      ownerShares: [
        { ownerId: "one", name: "Первый", share: 0.33 },
        { ownerId: "two", name: "Второй", share: 0.34 },
        { ownerId: "three", name: "Третий", share: 0.33 },
      ],
    }],
    events: [{
      id: "event", businessId: "padel", unit: "padel", eventTypeId: "type", title: "Летний кубок",
      status: "completed", settlementStatus: "open", startsAt: "2026-08-04T12:00:00.000Z",
      defaultFee: 50, capacity: 2, venueId: "venue", responsibleId: "staff", history: [],
    }],
    eventRegistrations: [
      { id: "r1", businessId: "padel", unit: "padel", eventId: "event", participantType: "player", participantId: "player", status: "attended", chargeAmount: 100 },
      { id: "r2", businessId: "padel", unit: "padel", eventId: "event", participantType: "contact", participantId: "contact", status: "confirmed", chargeAmount: 50 },
    ],
    eventBudgetLines: [
      { id: "b1", businessId: "padel", unit: "padel", eventId: "event", name: "Взносы", direction: "income", plannedAmount: 0 },
      { id: "b2", businessId: "padel", unit: "padel", eventId: "event", name: "Медали", direction: "expense", plannedAmount: 20 },
    ],
    finance: [
      { id: "income", businessId: "padel", unit: "padel", type: "income", amount: 100.01 },
      { id: "expense", businessId: "padel", unit: "padel", type: "expense", amount: 20.01 },
      { id: "refund", businessId: "padel", unit: "padel", type: "expense", amount: 5 },
    ],
    eventFinanceAllocations: [
      { id: "a1", businessId: "padel", unit: "padel", eventId: "event", financeId: "income", registrationId: "r1", purpose: "payment", amount: 90.01, idempotencyKey: "payment:one" },
      { id: "a2", businessId: "padel", unit: "padel", eventId: "event", financeId: "income", registrationId: "r1", purpose: "deposit", amount: 10, idempotencyKey: "deposit:one" },
      { id: "a3", businessId: "padel", unit: "padel", eventId: "event", financeId: "expense", budgetLineId: "b2", purpose: "expense", amount: 20.01, idempotencyKey: "expense:one" },
      { id: "a4", businessId: "padel", unit: "padel", eventId: "event", financeId: "refund", registrationId: "r1", purpose: "refund", amount: 5, idempotencyKey: "refund:one" },
    ],
  };
}

test("сущности событий входят в серверный протокол и бизнес-изоляцию", () => {
  assert.deepEqual(EVENT_ENTITIES, ["eventTypes", "events", "eventRegistrations", "eventBudgetLines", "eventFinanceAllocations"]);
  for (const entity of EVENT_ENTITIES) {
    assert.equal(ENTITIES.includes(entity), true, entity);
    assert.equal(BUSINESS_SCOPED_ENTITIES.includes(entity), true, entity);
  }
  assert.equal(baseWriteError(staff, "eventTypes"), "Только для админа");
  assert.equal(baseWriteError(admin, "eventFinanceAllocations"), "Финансовое распределение создаётся отдельным безопасным действием");
});

test("module gate и безопасные ссылки не позволяют пересекать бизнесы", () => {
  const data = fixture();
  assert.equal(eventModuleWriteError(data.businesses, data.events[0]), null);
  assert.equal(eventModuleWriteError(data.businesses, { businessId: "dev", unit: "dev" }), "Модуль «События» выключен для этого бизнеса");
  assert.equal(eventRecordError("events", data.events[0], data), null);
  assert.equal(eventRecordError("events", { ...data.events[0], venueId: "foreign" }, data), "Площадка не найдена в этом бизнесе");
  assert.equal(eventRecordError("eventRegistrations", data.eventRegistrations[0], data, "r1"), null);
  assert.equal(eventRecordError("eventRegistrations", { ...data.eventRegistrations[0], participantId: "foreign" }, data, "r1"), "Участник не найден в этом бизнесе");
  assert.equal(eventRecordError("eventRegistrations", { ...data.eventRegistrations[0], participantId: "contact", participantType: "contact" }, data, "r1"), "Нельзя изменить событие или участника регистрации со связанной оплатой");
  assert.equal(eventRecordError("eventFinanceAllocations", { ...data.eventFinanceAllocations[0], amount: 1.001 }, data), "Сумма распределения указывается с точностью до копеек");
});

test("экономика считает план, факт, долг, депозит, возврат и прибыль в копейках", () => {
  const data = fixture();
  assert.deepEqual(eventEconomy(data.events[0], data), {
    participantCount: 2, accrued: 150, depositApplied: 10, paid: 100.01, debt: 49.99, refunds: 5,
    plannedIncome: 0, plannedExpenses: 20, plannedProfit: -20, plannedMargin: null, plannedProfitPerParticipant: -10,
    actualIncome: 100.01, directExpenses: 20.01, profit: 75,
    margin: 75 / 100.01, profitPerParticipant: 37.5,
  });
});

test("закрывающий снимок распределяет последнюю копейку без потери", () => {
  const data = fixture();
  data.eventFinanceAllocations = [data.eventFinanceAllocations[0], data.eventFinanceAllocations[1]];
  const snapshot = eventSettlementSnapshot(data.events[0], data, 123);
  assert.equal(snapshot.profit, 100.01);
  assert.equal(snapshot.ownerShares.reduce((sum, share) => sum + Math.round(share.amount * 100), 0), 10_001);
  assert.deepEqual(snapshot.ownerShares.map((share) => share.amount), [33, 34, 33.01]);
  assert.equal(snapshot.completedAt, 123);
});

test("убыток распределяется тем же округлением, что и PostgreSQL", () => {
  const data = fixture();
  data.eventFinanceAllocations = [
    { id: "loss", businessId: "padel", unit: "padel", eventId: "event", financeId: "refund", registrationId: "r1", purpose: "refund", amount: 1.5, idempotencyKey: "loss:refund" },
  ];
  const snapshot = eventSettlementSnapshot(data.events[0], data, 123);
  assert.equal(snapshot.profit, -1.5);
  assert.deepEqual(snapshot.ownerShares.map((share) => share.amount), [-0.5, -0.51, -0.49]);
  assert.equal(snapshot.ownerShares.reduce((sum, share) => sum + Math.round(share.amount * 100), 0), -150);
});

test("сотрудник видит события и участников, но не прибыль и доли владельцев", () => {
  const data = fixture();
  const visible = visibleBootstrapData(staff, data);
  assert.equal(visible.events.length, 1);
  assert.equal(visible.eventRegistrations.length, 2);
  assert.equal(visible.eventTypes[0].ownerShares, undefined);
  assert.equal(visible.events[0].settlement, undefined);
  assert.deepEqual(visible.eventBudgetLines, []);
  assert.deepEqual(visible.eventFinanceAllocations, []);
});

test("завершённое событие и финансовая история не удаляются", () => {
  const data = fixture();
  assert.equal(eventDeleteError("events", data.events[0], data), "Завершённое событие нельзя удалить");
  assert.equal(eventDeleteError("eventFinanceAllocations", data.eventFinanceAllocations[0], data), "Финансовые распределения нельзя изменять или удалять");
  assert.equal(eventDeleteError("eventRegistrations", data.eventRegistrations[0], data), "Регистрацию со связанной оплатой нельзя удалить");
  assert.equal(eventDeleteError("eventBudgetLines", data.eventBudgetLines[1], data), "Строку бюджета со связанной финансовой операцией нельзя удалить");
});
