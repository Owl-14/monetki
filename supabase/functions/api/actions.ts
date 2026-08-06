import {
  BUSINESS_SCOPED_ENTITIES,
  BACKUP_ENTITIES,
  BANK_RULE_ENTITIES,
  CORE_ENTITIES,
  CRM_ENTITIES,
  ENTITIES,
  EXPENSE_UNITS,
  STOCK_ENTITIES,
  accessSet,
  baseWriteError,
  businessIdOf,
  canSeeItem,
  crmDeleteError,
  hasBusinessAccess,
  isAdmin,
  normalizeCrmRecord,
  normalizeScope,
  profileOf,
  scopeMismatch,
  scopeWriteError,
  validateCoreEntity,
  validateCrmEntity,
  visibleBootstrapData,
} from "./rules.js";
import { stockModuleWriteError, stockRecordError } from "./stock-rules.js";
import {
  EVENT_ENTITIES,
  eventDeleteError,
  eventModuleWriteError,
  eventReferenceDeleteError,
  eventRecordError,
  staffEventManageError,
  visibleEventCollections,
} from "./event-rules.js";
import {
  applyReservationChange,
  completeInventory,
  createStockMovement,
  deleteStockCatalog,
  readStockData,
  saveInventory,
} from "./stock.ts";
import {
  allocateEventFinance,
  closeEventSettlement as closeEventSettlementRpc,
  deleteEvent as deleteEventRpc,
  readEventData,
} from "./events.ts";
import { ensureCoreData } from "./auth/access.ts";
import { callRpc, deleteRow, insertRow, kvGet, kvSet, readAll, readOne, writeRow } from "./db/repositories.ts";
import { newId } from "./types.ts";
import type { Rec } from "./types.ts";
import { manualProcessBankTransaction } from "./bank-rule-actions.ts";
import { isSafeBankSignals } from "./bank-rules.js";

async function notify(toId: unknown, text: string, link = "#/tasks") {
  if (!toId) return;
  await writeRow("notifications", {
    id: newId(), toId, text, link, read: false, created: Date.now(),
  });
}

async function notifyAdmins(exceptId: string, text: string, link: string) {
  const emps = await readAll("employees");
  for (const a of emps) {
    if (a.role === "admin" && a.active && a.id !== exceptId) await notify(a.id, text, link);
  }
}

// ---------- Действия ----------

export async function bootstrap(u: Rec) {
  const admin = isAdmin(u);
  const entries = await Promise.all(ENTITIES.map(async (entity) => [entity, await readAll(entity)] as const));
  const data = Object.fromEntries(entries) as Record<string, Rec[]>;
  return {
    ok: true,
    profile: profileOf(u, data.memberships),
    data: visibleBootstrapData(
      u,
      data,
      admin ? await kvGet("BANK_BALANCE") : null,
    ),
  };
}

export async function processBankTransaction(u: Rec, id: unknown, businessId: unknown, category: unknown) {
  if (!isAdmin(u)) return { ok: false, error: "Только для админа" };
  return await manualProcessBankTransaction(u, id, businessId, category);
}

async function coreValidationError(entity: string, item: Rec, ignoreId = "") {
  if (!CORE_ENTITIES.includes(entity)) return null;
  const [businesses, employees, memberships, businessOwners] = await Promise.all([
    readAll("businesses"), readAll("employees"), readAll("memberships"), readAll("businessOwners"),
  ]);
  return validateCoreEntity(entity, item, { businesses, employees, memberships, businessOwners }, ignoreId);
}

async function crmValidationError(entity: string, item: Rec) {
  if (!CRM_ENTITIES.includes(entity)) return null;
  const entities = ["employees", "memberships", "clients", ...CRM_ENTITIES];
  const records = await Promise.all(entities.map(readAll));
  const data = Object.fromEntries(entities.map((name, index) => [name, records[index]]));
  return validateCrmEntity(entity, item, data);
}

async function crmDeleteValidationError(entity: string, item: Rec) {
  if (!CRM_ENTITIES.includes(entity)) return null;
  const records = await Promise.all(CRM_ENTITIES.map(readAll));
  const data = Object.fromEntries(CRM_ENTITIES.map((name, index) => [name, records[index]]));
  return crmDeleteError(entity, item, data);
}

async function crmUpdateValidationError(entity: string, before: Rec, after: Rec) {
  if (!CRM_ENTITIES.includes(entity)) return null;
  if (businessIdOf(before) !== businessIdOf(after)) return "Нельзя переносить CRM-запись в другой бизнес";
  if (entity !== "contacts" && entity !== "stages") return null;
  const deals = await readAll("deals");
  if (entity === "contacts" && before.companyId !== after.companyId && deals.some((deal) => deal.contactId === before.id)) {
    return "Контакт используется в сделках";
  }
  if (entity === "stages" && before.pipelineId !== after.pipelineId && deals.some((deal) => deal.stageId === before.id)) {
    return "Стадия используется в сделках";
  }
  return null;
}

export async function backup(u: Rec) {
  if (!isAdmin(u)) return { ok: false, error: "Только для админа" };
  const entries = await Promise.all(BACKUP_ENTITIES.map(async (entity) => [entity, await readAll(entity)] as const));
  return { ok: true, data: Object.fromEntries(entries) as Record<string, Rec[]> };
}

function normalizeEventRecord(entity: string, source: Rec) {
  const item = { ...source } as Rec;
  if (entity === "eventTypes") {
    item.active = item.active !== false;
    item.defaultFee = Number(item.defaultFee || 0);
    item.staffRate = Number(item.staffRate || 0);
    item.ownerShares = Array.isArray(item.ownerShares) ? item.ownerShares : [];
  }
  if (entity === "events") {
    item.status = item.status || "planned";
    item.settlementStatus = item.settlementStatus || "open";
    item.defaultFee = Number(item.defaultFee || 0);
    item.capacity = Number(item.capacity || 0);
  }
  if (entity === "eventRegistrations") {
    item.status = item.status || "registered";
    item.chargeAmount = Number(item.chargeAmount || 0);
  }
  if (entity === "eventBudgetLines") item.plannedAmount = Number(item.plannedAmount || 0);
  if (entity === "eventFinanceAllocations") item.amount = Number(item.amount || 0);
  return item;
}

function sanitizeStaffEventPayload(entity: string, item: Rec) {
  if (entity === "events") {
    delete item.ownerShares;
    delete item.staffRate;
    delete item.chargeAmount;
  }
  if (entity === "eventRegistrations") {
    delete item.ownerShares;
    delete item.defaultFee;
    delete item.staffRate;
    delete item.settlement;
  }
  return item;
}

async function eventValidationError(entity: string, item: Rec, ignoreId = "") {
  if (!EVENT_ENTITIES.includes(entity)) return null;
  return eventRecordError(entity, item, await readEventData(), ignoreId);
}

async function visibleEventMutation(u: Rec, entity: string, item: Rec) {
  if (isAdmin(u) || !EVENT_ENTITIES.includes(entity)) return item;
  const data = await readEventData();
  const visible = visibleEventCollections(u, data, false) as Record<string, Rec[]>;
  return (visible[entity] || []).find((candidate) => candidate.id === item.id) || { id: item.id };
}

function appendEventHistory(before: Rec | null, item: Rec, userId: string) {
  const at = Date.now();
  const history = Array.isArray(before?.history) ? [...before.history] : [];
  const changed = before
    ? Object.keys(item).filter((key) => !["history", "updated", "created"].includes(key)
      && JSON.stringify(before[key]) !== JSON.stringify(item[key]))
    : [];
  history.push({
    id: newId(), at, byId: userId, action: before ? "updated" : "created",
    fromStatus: before?.status || null, toStatus: item.status || null, changed,
  });
  return history;
}
// Зарплата с зачётом трат сотрудника: уменьшаем сумму, помечаем траты погашенными
async function applySalaryOffsets(item: Rec): Promise<{ error?: string; sum?: number; titles?: string }> {
  const ids = (item.offsetIds as string[]) || [];
  delete item.offsetIds;
  if (!ids.length || item.category !== "Зарплата" || !item.employeeId) return {};
  const all = await readAll("staffExpenses");
  const exps = all.filter((e) => ids.includes(e.id) && e.employeeId === item.employeeId && e.status === "pending");
  const sum = exps.reduce((s, e) => s + Number(e.amount || 0), 0);
  if (!sum) return {};
  if (Number(item.amount) < sum) return { error: "Сумма трат больше зарплаты" };
  item.amount = Number(item.amount) - sum;
  item.comment = (String(item.comment || "") + ` (за вычетом трат ${sum} ₽)`).trim();
  for (const e of exps) {
    e.status = "returned_salary";
    e.updated = Date.now();
    await writeRow("staffExpenses", e);
  }
  return { sum, titles: exps.map((e) => e.title).join(", ") };
}

function bankManagedFinancePayload(item: Rec) {
  return item?.source === "bank" || String(item?.bankId || "") !== ""
    || ["bankQueueId", "bankSignals", "bankSignalFingerprint", "bankOriginal", "appliedRuleId", "appliedRuleVersion", "applicationId"]
      .some((key) => item?.[key] !== undefined && item?.[key] !== null && item?.[key] !== "");
}

export async function createItem(u: Rec, entity: string, item: Rec) {
  const deny = baseWriteError(u, entity);
  if (deny) return { ok: false, error: deny };
  item = { ...item };
  if (entity === "finance" && bankManagedFinancePayload(item)) return { ok: false, error: "Банковская операция создаётся только из необработанной очереди" };
  delete item.staffAmount;
  if (!isAdmin(u)) item = sanitizeStaffEventPayload(entity, item);
  if (entity === "businesses") item.id = String(item.id || "").trim();
  if (entity === "businessOwners") item.ownerId = String(item.ownerId || "").trim();
  if (entity === "warehouses" || entity === "stockItems") item.active = item.active !== false;
  if (entity === "stockItems") {
    item.costPrice = item.costPrice === "" || item.costPrice === undefined ? 0 : Number(item.costPrice);
    item.minStock = item.minStock === "" || item.minStock === undefined ? 0 : Number(item.minStock);
  }
  if (entity === "reservations") item.status = item.status || "active";
  if (entity === "inventories") item.status = item.status || "draft";
  if (EVENT_ENTITIES.includes(entity)) item = normalizeEventRecord(entity, item);
  if (entity === "events") {
    item.settlementStatus = "open";
    delete item.settlement;
    delete item.settlementClosedAt;
    delete item.completedAt;
  }
  const coreDeny = await coreValidationError(entity, item);
  if (coreDeny) return { ok: false, error: coreDeny };
  const [memberships, businesses] = await Promise.all([readAll("memberships"), readAll("businesses")]);
  const access = accessSet(memberships, u.id);
  if (entity === "staffExpenses" && !isAdmin(u) && !businessIdOf(item)) {
    item = normalizeScope(item, String(u.unit || "")) as Rec;
  }
  if (BUSINESS_SCOPED_ENTITIES.includes(entity) || entity === "memberships" || entity === "businessOwners") {
    const scopeDeny = scopeWriteError(access, item, businesses);
    if (scopeDeny) return { ok: false, error: scopeDeny };
    item = normalizeScope(item) as Rec;
  }
  if (CRM_ENTITIES.includes(entity)) item = normalizeCrmRecord(entity, item) as Rec;
  const crmDeny = await crmValidationError(entity, item);
  if (crmDeny) return { ok: false, error: crmDeny };
  if (STOCK_ENTITIES.includes(entity)) {
    const moduleDeny = stockModuleWriteError(businesses, item);
    if (moduleDeny) return { ok: false, error: moduleDeny };
  }
  if (EVENT_ENTITIES.includes(entity)) {
    const moduleDeny = eventModuleWriteError(businesses, item);
    if (moduleDeny) return { ok: false, error: moduleDeny };
    const eventData = await readEventData();
    if (!isAdmin(u) && entity === "events") {
      const type = (eventData.eventTypes || []).find((candidate) => candidate.id === item.eventTypeId
        && businessIdOf(candidate) === businessIdOf(item));
      item.defaultFee = Number(type?.defaultFee || 0);
      item.responsibleId = u.id;
    }
    if (!isAdmin(u) && entity === "eventRegistrations") {
      const event = (eventData.events || []).find((candidate) => candidate.id === item.eventId
        && businessIdOf(candidate) === businessIdOf(item));
      const manageDeny = staffEventManageError(u, event);
      if (manageDeny) return { ok: false, error: manageDeny };
      item.chargeAmount = Number(event?.defaultFee || 0);
    }
    const eventDeny = eventRecordError(entity, item, eventData);
    if (eventDeny) return { ok: false, error: eventDeny };
  }
  // id всегда генерируем на сервере: иначе, прислав чужой id, можно было бы
  // перезаписать (upsert) существующую запись в своём направлении.
  item.id = entity === "businesses" && item.id ? item.id : newId();
  item.created = Date.now();
  item.updated = Date.now();
  if (entity === "events") item.history = appendEventHistory(null, item, String(u.id));
  if (STOCK_ENTITIES.includes(entity) && entity !== "stockMovements") {
    const stockDeny = stockRecordError(entity, item, await readStockData());
    if (stockDeny) return { ok: false, error: stockDeny };
  }
  if (entity === "employees" && !item.code) {
    item.code = String(Math.floor(100000 + Math.random() * 900000));
  }
  if (entity === "tasks") {
    item.authorId = item.authorId || u.id;
    item.comments = item.comments || [];
    if (!isAdmin(u)) item.assigneeId = u.id; // сотрудник ставит задачи только себе
    if (item.assigneeId && item.assigneeId !== u.id) {
      await notify(item.assigneeId, `Новая задача: ${item.title}`);
    }
  }
  if (entity === "staffExpenses") {
    const exUnit = businessIdOf(item) || (isAdmin(u) ? "padel" : String(u.unit || ""));
    if (!EXPENSE_UNITS.includes(String(exUnit)) && exUnit !== "all") {
      return { ok: false, error: "Траты для этого направления отключены" };
    }
    if (!item.receiptId) return { ok: false, error: "Прикрепите фото чека" };
    if (!isAdmin(u)) {
      item.employeeId = u.id;
      item = normalizeScope(item, String(u.unit === "all" ? (item.businessId || item.unit || "padel") : u.unit)) as Rec;
    }
    item.status = item.status || "pending";
    await notifyAdmins(u.id as string, `${u.name}: трата ${item.amount} ₽ — ${item.title}`, "#/finance");
  }
  if (entity === "stockMovements") {
    if (item.type === "inventory") {
      return { ok: false, error: "Корректировка создаётся только завершением инвентаризации" };
    }
    item.createdBy = u.id;
    return await createStockMovement(item);
  }
  if (entity === "reservations") {
    return await applyReservationChange(null, item);
  }
  if (entity === "inventories") {
    item.createdBy = u.id;
    if (item.status === "completed") return await completeInventory(item, true);
  }
  let offsets: { error?: string; sum?: number; titles?: string } = {};
  if ((entity === "finance" || entity === "cash") && item.category === "Зарплата") {
    offsets = await applySalaryOffsets(item);
    if (offsets.error) return { ok: false, error: offsets.error };
  }
  if (entity === "businesses") {
    if (!await insertRow(entity, item)) return { ok: false, error: "Бизнес с таким ID уже существует" };
    const membershipId = `membership-${item.id}-${u.id}`;
    const ownerRecordId = `business-owner-${item.id}-${u.id}`;
    try {
      await writeRow("memberships", {
        id: membershipId, businessId: item.id, unit: item.id,
        employeeId: u.id, role: "owner", active: true, created: Date.now(), updated: Date.now(),
      });
      await writeRow("businessOwners", {
        id: ownerRecordId, businessId: item.id, unit: item.id, ownerId: u.id,
        name: u.name, share: 1, active: true, created: Date.now(), updated: Date.now(),
      });
    } catch (error) {
      await deleteRow("memberships", membershipId);
      await deleteRow(entity, item.id);
      throw error;
    }
  } else if (entity === "eventRegistrations") {
    if (!await insertRow(entity, item)) return { ok: false, error: "Участник уже зарегистрирован на это событие" };
  } else {
    await writeRow(entity, item);
  }
  if (entity === "employees" || entity === "businesses") await ensureCoreData();
  if (offsets.sum) {
    await writeRow(entity, {
      id: newId(), businessId: item.businessId, unit: item.unit, owner: item.owner, date: item.date,
      type: "expense", amount: offsets.sum, method: item.method || "cash", source: "manual",
      category: "Компенсация сотруднику", counterparty: "", comment: `Зачтено в зарплате: ${offsets.titles}`,
      employeeId: item.employeeId, created: Date.now(), updated: Date.now(),
    });
  }
  if ((entity === "finance" || entity === "cash") && item.employeeId) {
    await notify(
      item.employeeId,
      `Вам ${item.category === "Зарплата" ? "начислена зарплата" : "проведена выплата"}: ${item.amount} ₽${entity === "cash" ? " (наличными)" : ""}`,
      "#/money",
    );
  }
  return { ok: true, item: await visibleEventMutation(u, entity, item) };
}

export async function updateItem(u: Rec, entity: string, item: Rec) {
  const deny = baseWriteError(u, entity);
  if (deny) return { ok: false, error: deny };
  item = { ...item };
  if (entity === "finance" && bankManagedFinancePayload(item)) return { ok: false, error: "Банковская операция изменяется только специальным действием" };
  delete item.staffAmount;
  if (!isAdmin(u)) item = sanitizeStaffEventPayload(entity, item);
  if (entity === "companies" && String(item?.id || "").startsWith("legacy-client:")) {
    return { ok: false, error: "Переходная запись клиента доступна только для чтения" };
  }
  if (entity === "stockMovements") return { ok: false, error: "Движения склада нельзя изменять" };
  const before = (await readAll(entity)).find((x) => x.id === item.id);
  if (!before) return { ok: false, error: "Не найдено" };
  if (entity === "finance" && bankManagedFinancePayload(before)) {
    return { ok: false, error: "Банковская операция изменяется только специальным действием" };
  }
  const [memberships, businesses] = await Promise.all([readAll("memberships"), readAll("businesses")]);
  const access = accessSet(memberships, u.id);
  if (BUSINESS_SCOPED_ENTITIES.includes(entity) || entity === "memberships" || entity === "businessOwners") {
    const sourceDeny = scopeWriteError(access, before, businesses);
    if (sourceDeny) return { ok: false, error: sourceDeny };
    if (scopeMismatch(item)) return { ok: false, error: "businessId и unit должны совпадать" };
    const targetBusinessId = String(item.businessId || item.unit || businessIdOf(before));
    if ((STOCK_ENTITIES.includes(entity) || EVENT_ENTITIES.includes(entity)) && targetBusinessId !== businessIdOf(before)) {
      return { ok: false, error: `Нельзя перенести ${STOCK_ENTITIES.includes(entity) ? "складскую" : "событийную"} запись в другой бизнес` };
    }
    const targetDeny = scopeWriteError(access, { id: "target", businessId: targetBusinessId, unit: targetBusinessId }, businesses);
    if (targetDeny) return { ok: false, error: targetDeny };
    item = { ...item, businessId: targetBusinessId, unit: targetBusinessId };
  }
  if (STOCK_ENTITIES.includes(entity)) {
    const moduleDeny = stockModuleWriteError(businesses, before);
    if (moduleDeny) return { ok: false, error: moduleDeny };
  }
  if (EVENT_ENTITIES.includes(entity)) {
    const moduleDeny = eventModuleWriteError(businesses, before);
    if (moduleDeny) return { ok: false, error: moduleDeny };
    if (!isAdmin(u) && entity === "events") {
      const manageDeny = staffEventManageError(u, before);
      if (manageDeny) return { ok: false, error: manageDeny };
    }
    if (!isAdmin(u) && entity === "eventRegistrations") {
      const parent = (await readAll("events")).find((candidate) => candidate.id === before.eventId);
      const manageDeny = staffEventManageError(u, parent);
      if (manageDeny) return { ok: false, error: manageDeny };
    }
  }
  if (entity === "businesses" && !hasBusinessAccess(access, before.id)) return { ok: false, error: "Нет доступа к этому бизнесу" };
  const coreDeny = await coreValidationError(entity, { ...before, ...item } as Rec, before.id);
  if (coreDeny) return { ok: false, error: coreDeny };
  if (entity === "staffExpenses" && !isAdmin(u)) {
    if (before.employeeId !== u.id) return { ok: false, error: "Нет доступа" };
    if (before.status !== "pending") return { ok: false, error: "Эта трата уже возвращена" };
    item.employeeId = u.id;
    item.status = "pending";
  }
  // сотрудник меняет содержимое только своих задач; в поставленных админом — только статус
  if (entity === "tasks" && !isAdmin(u) && before.authorId !== u.id) {
    if (before.assigneeId !== u.id) return { ok: false, error: "Нет доступа" };
    item = { id: before.id, status: item.status } as Rec;
  }
  if (entity === "events" && before.settlementStatus === "closed") {
    return { ok: false, error: "Закрытый расчёт события нельзя изменять" };
  }
  if (!isAdmin(u) && entity === "events") {
    if (("defaultFee" in item && Number(item.defaultFee) !== Number(before.defaultFee))
      || ("eventTypeId" in item && item.eventTypeId !== before.eventTypeId)
      || ("responsibleId" in item && item.responsibleId !== before.responsibleId)) {
      return { ok: false, error: "Сотрудник не может менять тип, ответственного или финансовые условия события" };
    }
    item = { ...item, defaultFee: before.defaultFee, eventTypeId: before.eventTypeId, responsibleId: before.responsibleId } as Rec;
  }
  if (!isAdmin(u) && entity === "eventRegistrations") {
    if ("chargeAmount" in item && Number(item.chargeAmount) !== Number(before.chargeAmount)) {
      return { ok: false, error: "Сотрудник не может менять начисление участника" };
    }
    item = { ...item, chargeAmount: before.chargeAmount } as Rec;
  }
  if (entity === "events" && item.settlementStatus && item.settlementStatus !== before.settlementStatus) {
    return { ok: false, error: "Расчёт события закрывается отдельным безопасным действием" };
  }
  if (entity === "events" && ["settlement", "settlementClosedAt", "completedAt"].some((key) =>
    key in item && JSON.stringify(item[key]) !== JSON.stringify(before[key])
  )) return { ok: false, error: "Системные итоги события нельзя изменять вручную" };
  if (entity === "finance") {
    const allocations = await readAll("eventFinanceAllocations");
    const financeAfter = { ...before, ...item } as Rec;
    if (allocations.some((allocation) => allocation.financeId === before.id)
      && (businessIdOf(before) !== businessIdOf(financeAfter) || before.type !== financeAfter.type || Number(before.amount) !== Number(financeAfter.amount))) {
      return { ok: false, error: "Нельзя изменить сумму, тип или бизнес связанной финансовой операции" };
    }
  }
  const normalizedMerged = EVENT_ENTITIES.includes(entity)
    ? normalizeEventRecord(entity, { ...before, ...item, updated: Date.now() } as Rec)
    : { ...before, ...item, updated: Date.now() } as Rec;
  const merged = normalizeCrmRecord(entity, normalizedMerged) as Rec;
  const crmUpdateDeny = await crmUpdateValidationError(entity, before, merged);
  if (crmUpdateDeny) return { ok: false, error: crmUpdateDeny };
  const crmDeny = await crmValidationError(entity, merged);
  if (crmDeny) return { ok: false, error: crmDeny };
  if (entity === "inventories" && before.status === "completed") {
    return { ok: false, error: "Завершённую инвентаризацию нельзя изменять" };
  }
  if (entity === "reservations" && before.status === "released") {
    return { ok: false, error: "Освобождённый резерв нельзя изменять" };
  }
  if (STOCK_ENTITIES.includes(entity)) {
    const stockDeny = stockRecordError(entity, merged, await readStockData(), before.id);
    if (stockDeny) return { ok: false, error: stockDeny };
  }
  if (EVENT_ENTITIES.includes(entity)) {
    const eventDeny = await eventValidationError(entity, merged, before.id);
    if (eventDeny) return { ok: false, error: eventDeny };
  }
  if (entity === "reservations") {
    return await applyReservationChange(before, merged);
  }
  if (entity === "inventories") {
    if (merged.status === "completed") return await completeInventory(merged, false, before);
    return await saveInventory(before, merged);
  }
  if (entity === "tasks") {
    if (before.status !== merged.status && merged.authorId && merged.authorId !== u.id) {
      const names: Record<string, string> = { new: "Не видел", progress: "В работе", question: "Есть вопросы", done: "Выполнена" };
      await notify(merged.authorId, `${u.name} — «${merged.title}»: ${names[merged.status as string] || merged.status}`);
    }
    if (before.assigneeId !== merged.assigneeId && merged.assigneeId && merged.assigneeId !== u.id) {
      await notify(merged.assigneeId, `Вам передали задачу: ${merged.title}`);
    }
  }
  if (entity === "events") {
    merged.history = appendEventHistory(before, merged, String(u.id));
    if (before.status !== "completed" && merged.status === "completed") merged.completedAt = Date.now();
  }
  await writeRow(entity, merged);
  return { ok: true, item: await visibleEventMutation(u, entity, merged) };
}

export async function deleteItem(u: Rec, entity: string, id: string) {
  const baseDeny = baseWriteError(u, entity);
  if (baseDeny) return { ok: false, error: baseDeny };
  if (entity === "companies" && String(id || "").startsWith("legacy-client:")) {
    return { ok: false, error: "Переходная запись клиента доступна только для чтения" };
  }
  const before = (await readAll(entity)).find((x) => x.id === id);
  if (!before) return { ok: false, error: "Не найдено" };
  if (entity === "finance" && bankManagedFinancePayload(before)) {
    return { ok: false, error: "Банковская операция удаляется только безопасной отменой из журнала" };
  }
  const [memberships, businesses] = await Promise.all([readAll("memberships"), readAll("businesses")]);
  const access = accessSet(memberships, u.id);
  if (BUSINESS_SCOPED_ENTITIES.includes(entity) || entity === "memberships" || entity === "businessOwners") {
    const sourceDeny = scopeWriteError(access, before, businesses);
    if (sourceDeny) return { ok: false, error: sourceDeny };
  }
  if (STOCK_ENTITIES.includes(entity)) {
    const moduleDeny = stockModuleWriteError(businesses, before);
    if (moduleDeny) return { ok: false, error: moduleDeny };
  }
  if (EVENT_ENTITIES.includes(entity)) {
    const moduleDeny = eventModuleWriteError(businesses, before);
    if (moduleDeny) return { ok: false, error: moduleDeny };
    const eventData = await readEventData();
    const parent = entity === "events"
      ? before
      : (eventData.events || []).find((candidate) => candidate.id === before.eventId);
    const manageDeny = staffEventManageError(u, parent);
    if (manageDeny) return { ok: false, error: manageDeny };
    const eventDeny = eventDeleteError(entity, before, eventData);
    if (eventDeny) return { ok: false, error: eventDeny };
  }
  if (["players", "companies", "contacts", "venues"].includes(entity)) {
    const referenceDeny = eventReferenceDeleteError(entity, before, await readEventData());
    if (referenceDeny) return { ok: false, error: referenceDeny };
  }
  if (entity === "finance" && (await readAll("eventFinanceAllocations")).some((allocation) => allocation.financeId === before.id)) {
    return { ok: false, error: "Связанную финансовую операцию нельзя удалить" };
  }
  if (entity === "stockMovements") return { ok: false, error: "Движения склада нельзя удалять" };
  if (entity === "inventories" && before.status === "completed") {
    return { ok: false, error: "Завершённую инвентаризацию нельзя удалять" };
  }
  if (entity === "warehouses" || entity === "stockItems") {
    return await deleteStockCatalog(entity, before);
  }
  if (entity === "reservations") {
    return await applyReservationChange(before, null);
  }
  if (entity === "inventories") {
    return await saveInventory(before, null);
  }
  if (entity === "businesses" && !hasBusinessAccess(access, before.id)) return { ok: false, error: "Нет доступа к этому бизнесу" };
  if (entity === "staffExpenses" && !isAdmin(u) && (before.employeeId !== u.id || before.status !== "pending")) {
    return { ok: false, error: "Нет доступа" };
  }
  if (entity === "tasks" && !isAdmin(u) && before.authorId !== u.id) {
    return { ok: false, error: "Удалять можно только свои задачи" };
  }
  const crmDeny = await crmDeleteValidationError(entity, before);
  if (crmDeny) return { ok: false, error: crmDeny };
  if (entity === "tasks" && before.assigneeId && before.assigneeId !== u.id && before.status !== "done") {
    await notify(before.assigneeId, `Задача удалена: ${before.title}`);
  }
  if (entity === "businesses") {
    const archived = { ...before, active: false, updated: Date.now() } as Rec;
    await writeRow(entity, archived);
    return { ok: true, item: archived };
  }
  if (entity === "events") return await deleteEventRpc(before);
  await deleteRow(entity, id);
  return { ok: true };
}

export async function createEventFinanceAllocation(u: Rec, source: Rec) {
  if (!isAdmin(u)) return { ok: false, error: "Только для админа" };
  let item = normalizeEventRecord("eventFinanceAllocations", { ...source } as Rec);
  const data = await readEventData();
  const memberships = data.memberships || [];
  const businesses = data.businesses || [];
  const scopeDeny = scopeWriteError(accessSet(memberships, u.id), item, businesses);
  if (scopeDeny) return { ok: false, error: scopeDeny };
  item = normalizeScope(item) as Rec;
  const moduleDeny = eventModuleWriteError(businesses, item);
  if (moduleDeny) return { ok: false, error: moduleDeny };
  const existing = (data.eventFinanceAllocations || []).find((allocation) =>
    allocation.idempotencyKey === item.idempotencyKey && businessIdOf(allocation) === businessIdOf(item)
  );
  if (existing) {
    const keys = ["eventId", "financeId", "registrationId", "budgetLineId", "purpose", "amount"];
    if (keys.some((key) => String(existing[key] ?? "") !== String(item[key] ?? ""))) {
      return { ok: false, error: "Ключ повторяемости уже использован для другого распределения" };
    }
    return { ok: true, item: existing, alreadyAllocated: true };
  }
  const validationDeny = eventRecordError("eventFinanceAllocations", item, data);
  if (validationDeny) return { ok: false, error: validationDeny };
  const now = Date.now();
  item = { ...item, id: newId(), createdBy: u.id, created: now, updated: now };
  return await allocateEventFinance(item);
}

export async function closeEventSettlement(u: Rec, id: unknown) {
  if (!isAdmin(u)) return { ok: false, error: "Только для админа" };
  const eventId = String(id || "").trim();
  const data = await readEventData();
  const event = (data.events || []).find((candidate) => candidate.id === eventId);
  if (!event) return { ok: false, error: "Событие не найдено" };
  const scopeDeny = scopeWriteError(accessSet(data.memberships || [], u.id), event, data.businesses || []);
  if (scopeDeny) return { ok: false, error: scopeDeny };
  const moduleDeny = eventModuleWriteError(data.businesses || [], event);
  if (moduleDeny) return { ok: false, error: moduleDeny };
  if (!["completed", "cancelled"].includes(String(event.status || ""))) {
    return { ok: false, error: "Сначала завершите или отмените событие" };
  }
  return await closeEventSettlementRpc(event, String(u.id));
}

/**
 * Ежедневные напоминания о дедлайнах (запускаются с ежечасным cron'ом,
 * срабатывают один раз в день после 9:00 по Москве).
 */
export async function remindDeadlines() {
  try {
    const now = new Date();
    const mskHour = Number(new Intl.DateTimeFormat("ru-RU", { hour: "numeric", hour12: false, timeZone: "Europe/Moscow" }).format(now));
    const todayMsk = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(now);
    if (mskHour < 9) return;
    if (await kvGet("LAST_REMIND") === todayMsk) return;
    const tasks = await readAll("tasks");
    for (const t of tasks) {
      if (t.status === "done" || !t.due || !t.assigneeId) continue;
      const due = String(t.due).slice(0, 10);
      if (due <= todayMsk) {
        await notify(t.assigneeId, `⏰ ${due < todayMsk ? "Просрочена задача" : "Сегодня срок задачи"}: ${t.title}`);
      }
    }
    await kvSet("LAST_REMIND", todayMsk);
  } catch (_e) { /* напоминания не должны ломать синхронизацию */ }
}

export async function addComment(u: Rec, taskId: string, text: string) {
  const task = (await readAll("tasks")).find((t) => t.id === taskId);
  if (!task) return { ok: false, error: "Задача не найдена" };
  const [memberships, businesses] = await Promise.all([readAll("memberships"), readAll("businesses")]);
  const access = accessSet(memberships, u.id);
  if (!canSeeItem(access, task) || (!isAdmin(u) && task.assigneeId !== u.id)) return { ok: false, error: "Нет доступа" };
  const scopeDeny = scopeWriteError(access, task, businesses);
  if (scopeDeny) return { ok: false, error: scopeDeny };
  const comments = (task.comments as Record<string, unknown>[]) || [];
  comments.push({ authorId: u.id, text: String(text).slice(0, 2000), ts: Date.now() });
  task.comments = comments;
  await writeRow("tasks", task);
  const others = [...new Set([task.authorId, task.assigneeId].filter((id) => id && id !== u.id))];
  for (const id of others) {
    await notify(id, `${u.name}: ${String(text).slice(0, 80)} (задача «${task.title}»)`);
  }
  return { ok: true, item: task };
}

export async function importPlayers(u: Rec, rows: Rec[]) {
  const [memberships, businesses] = await Promise.all([readAll("memberships"), readAll("businesses")]);
  const access = accessSet(memberships, u.id);
  if (!hasBusinessAccess(access, "padel")) return { ok: false, error: "Нет доступа" };
  if (!businesses.some((business) => business.id === "padel" && business.active !== false)) {
    return { ok: false, error: "Бизнес в архиве" };
  }
  const existing = await readAll("players");
  let added = 0;
  for (const r of rows || []) {
    if (!r.name) continue;
    const dup = existing.find((p) =>
      String(p.name).toLowerCase() === String(r.name).toLowerCase() &&
      String(p.phone || "") === String(r.phone || "")
    );
    if (dup) continue;
    await writeRow("players", {
      id: newId(), businessId: "padel", unit: "padel", name: r.name, phone: r.phone || "",
      level: r.level || "", city: r.city || "", notes: r.notes || "",
      created: Date.now(), updated: Date.now(),
    });
    added++;
  }
  return { ok: true, added };
}

export async function markRead(u: Rec, ids: string[]) {
  const notifs = await readAll("notifications");
  for (const n of notifs) {
    if ((ids || []).includes(n.id) && n.toId === u.id && !n.read) {
      n.read = true;
      await writeRow("notifications", n);
    }
  }
  return { ok: true };
}

export async function resolveExpense(u: Rec, id: string, how: string) {
  if (!isAdmin(u)) return { ok: false, error: "Только для админа" };
  const ex = (await readAll("staffExpenses")).find((x) => x.id === id);
  if (!ex) return { ok: false, error: "Не найдено" };
  const [memberships, businesses] = await Promise.all([readAll("memberships"), readAll("businesses")]);
  const access = accessSet(memberships, u.id);
  const scopeDeny = scopeWriteError(access, ex, businesses);
  if (scopeDeny) return { ok: false, error: scopeDeny };
  if (ex.status !== "pending") return { ok: false, error: "Уже возвращено" };
  const cashOwner = String(how).startsWith("cash:") ? String(how).slice(5) : null;
  ex.status = cashOwner ? "returned_cash" : "returned_bank";
  ex.updated = Date.now();
  await writeRow("staffExpenses", ex);
  if (cashOwner) {
    // возврат наличными — списание из кассы владельца, в общую статистику не попадает
    await writeRow("cash", {
      id: newId(), owner: cashOwner, date: new Date().toISOString().slice(0, 10),
      type: "expense", amount: ex.amount, category: "Компенсация сотруднику",
      comment: ex.title, employeeId: ex.employeeId,
      created: Date.now(), updated: Date.now(),
    });
  }
  await notify(ex.employeeId, `Вам вернули ${ex.amount} ₽ (${cashOwner ? "наличными" : "со счёта"}) — ${ex.title}`, "#/money");
  return { ok: true, item: ex };
}

// ---------- Файлы (фото чеков) ----------

export async function uploadFile(u: Rec, b64: unknown) {
  const s = String(b64 || "");
  if (!s.startsWith("data:image/")) return { ok: false, error: "Нужно фото" };
  if (s.length > 2_000_000) return { ok: false, error: "Фото слишком большое" };
  const item = { id: newId(), b64: s, byId: u.id, created: Date.now() };
  await writeRow("files", item as Rec);
  return { ok: true, id: item.id };
}

export async function getFile(u: Rec, id: string) {
  const f = await readOne("files", id);
  if (!f) return { ok: false, error: "Не найдено" };
  if (!isAdmin(u) && f.byId !== u.id) {
    const linked = (await readAll("staffExpenses")).find((e) => e.receiptId === id);
    if (linked?.employeeId !== u.id) return { ok: false, error: "Нет доступа" };
  }
  return { ok: true, b64: f.b64 };
}

export async function statusInfo(u: Rec | null) {
  const employees = await readAll("employees");
  // Постороннему (и рядовому сотруднику) — только факт «база пустая»,
  // нужный для первичной загрузки резервной копии. Никаких счётчиков/сумм.
  if (!u || !isAdmin(u)) {
    return { ok: true, backend: "supabase", empty: employees.length === 0 };
  }
  const [finance, staffExpenses, lastSyncAttempt, lastSync, lastSyncError] = await Promise.all([
    readAll("finance"),
    readAll("staffExpenses"),
    kvGet("LAST_SYNC_ATTEMPT"),
    kvGet("LAST_SYNC"),
    kvGet("LAST_SYNC_ERROR"),
  ]);
  return {
    ok: true,
    backend: "supabase",
    empty: employees.length === 0,
    employees: employees.length,
    tochkaTokenSet: !!Deno.env.get("TOCHKA_TOKEN"),
    financeTotal: finance.length,
    financeFromBank: finance.filter((f) => f.source === "bank").length,
    staffExpensesPending: staffExpenses.filter((e) => e.status === "pending").length,
    lastSyncAttempt,
    lastSync,
    lastSyncError,
  };
}

// Первичный импорт резервной копии со старой базы.
// Разрешён без токена ТОЛЬКО пока база пустая (нет ни одного сотрудника).
export async function migrateImport(u: Rec | null, payload: Record<string, Rec[]>) {
  const empty = (await readAll("employees")).length === 0;
  if (!empty && (!u || !isAdmin(u))) return { ok: false, error: "Только для админа" };
  const ordinaryEntities = BACKUP_ENTITIES.filter((entity) =>
    !EVENT_ENTITIES.includes(entity) && !BANK_RULE_ENTITIES.includes(entity) && entity !== "bankTransactions"
  );
  const bankFinance = (payload?.finance || []).filter(bankManagedFinancePayload);
  const ordinary = Object.fromEntries(ordinaryEntities.map((entity) => [
    entity,
    (payload?.[entity] || []).filter((item) => entity !== "finance" || !bankManagedFinancePayload(item)),
  ]));
  for (const item of payload?.bankTransactions || []) {
    const amountMinor = Number(item?.bankSignals?.amountMinor);
    const visibleAmountMinor = Math.round(Number(item?.amount) * 100);
    const signalDirection = String(item?.bankSignals?.direction || "");
    const hasSignals = Object.keys(item?.bankSignals || {}).length > 0;
    if (!item?.id || !item?.bankId || !isSafeBankSignals(item.bankSignals || {})
      || ["raw", "payload", "token"].some((key) => item[key] !== undefined)
      || (hasSignals && (!Number.isSafeInteger(amountMinor) || amountMinor <= 0
        || amountMinor !== visibleAmountMinor || signalDirection !== String(item?.type || "")))) {
      return { ok: false, error: "Резервная копия содержит небезопасную банковскую очередь" };
    }
  }
  for (const item of bankFinance) {
    const amountMinor = Number(item?.bankSignals?.amountMinor);
    const hasSignals = Object.keys(item?.bankSignals || {}).length > 0;
    if (!item?.id || !item?.bankId || item?.source !== "bank" || !isSafeBankSignals(item.bankSignals || {})
      || ["raw", "payload", "token"].some((key) => item[key] !== undefined)
      || (hasSignals && (!Number.isSafeInteger(amountMinor) || amountMinor <= 0
        || amountMinor !== Math.round(Number(item?.amount) * 100)
        || String(item?.bankSignals?.direction || "") !== String(item?.type || "")))) {
      return { ok: false, error: "Резервная копия содержит небезопасную банковскую финансовую операцию" };
    }
  }
  const bankGraph = {
    ...Object.fromEntries(BANK_RULE_ENTITIES.map((entity) => [entity, payload?.[entity] || []])),
    bankFinance,
    bankTransactions: payload?.bankTransactions || [],
  };
  const eventGraph = Object.fromEntries(EVENT_ENTITIES.map((entity) => [entity, payload?.[entity] || []]));
  const { data: restored, error } = await callRpc("restore_monetki_backup", {
    p_graph: { ordinary, bank: bankGraph, events: eventGraph },
  });
  if (error || !(restored as Rec)?.ok) {
    return { ok: false, error: "Не удалось атомарно восстановить резервную копию" };
  }
  return { ok: true, imported: Number((restored as Rec).restored || 0) };
}
