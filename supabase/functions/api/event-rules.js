export const EVENT_ENTITIES = [
  "eventTypes", "events", "eventRegistrations", "eventBudgetLines", "eventFinanceAllocations",
];

export const EVENT_STATUSES = ["planned", "active", "completed", "cancelled"];
export const REGISTRATION_STATUSES = ["registered", "confirmed", "attended", "cancelled", "refunded"];
export const PARTICIPANT_TYPES = ["player", "company", "contact"];

const scopeOf = (item) => String(item?.businessId || item?.unit || "");
const moneyValue = (value) => Number(value || 0);
const cents = (value) => Math.round(moneyValue(value) * 100);
const fromCents = (value) => value / 100;
const signedRound = (value) => value < 0 ? -Math.round(-value) : Math.round(value);
const nonNegative = (value) => value !== "" && value !== null && Number.isFinite(Number(value)) && Number(value) >= 0;
const positive = (value) => value !== "" && value !== null && Number.isFinite(Number(value)) && Number(value) > 0;
const moneyPrecision = (value) => Math.abs(Number(value) * 100 - Math.round(Number(value) * 100)) < 0.000001;

function sameBusinessRecord(records, id, businessId) {
  return (records || []).find((record) => record.id === id && scopeOf(record) === businessId);
}

function eventOf(data, item) {
  return sameBusinessRecord(data.events, item.eventId, scopeOf(item));
}

export function eventModuleWriteError(businesses, item) {
  const business = (businesses || []).find((candidate) => candidate.id === scopeOf(item));
  if (!business || business.active === false) return "Бизнес в архиве";
  if (!Array.isArray(business.modules) || !business.modules.includes("events")) {
    return "Модуль «События» выключен для этого бизнеса";
  }
  return null;
}

export function ownerSharesForEvent(event, data) {
  const type = sameBusinessRecord(data.eventTypes, event?.eventTypeId, scopeOf(event));
  const configured = Array.isArray(type?.ownerShares) ? type.ownerShares : [];
  const shares = configured.length ? configured : (data.businessOwners || [])
    .filter((owner) => owner.active !== false && scopeOf(owner) === scopeOf(event))
    .map((owner) => ({ ownerId: owner.ownerId, name: owner.name, share: Number(owner.share || 0) }));
  return shares
    .map((share) => ({ ownerId: String(share.ownerId || ""), name: String(share.name || ""), share: Number(share.share || 0) }))
    .filter((share) => share.ownerId && share.share > 0);
}

export function eventEconomy(event, data) {
  const registrations = (data.eventRegistrations || []).filter((item) => item.eventId === event.id);
  const activeRegistrations = registrations.filter((item) => !["cancelled", "refunded"].includes(item.status));
  const budgetLines = (data.eventBudgetLines || []).filter((item) => item.eventId === event.id);
  const allocations = (data.eventFinanceAllocations || []).filter((item) => item.eventId === event.id);
  const financeById = new Map((data.finance || []).map((item) => [item.id, item]));

  const accruedCents = activeRegistrations.reduce((sum, item) => sum + cents(item.chargeAmount), 0);
  let depositCents = 0;
  let incomeCents = 0;
  let expenseCents = 0;
  let refundCents = 0;
  for (const allocation of allocations) {
    const finance = financeById.get(allocation.financeId);
    if (!finance) continue;
    const amount = cents(allocation.amount);
    if (finance.type === "income") incomeCents += amount;
    if (finance.type === "income" && allocation.purpose === "deposit") depositCents += amount;
    if (finance.type === "expense" && allocation.purpose === "refund") refundCents += amount;
    if (finance.type === "expense" && allocation.purpose !== "refund") expenseCents += amount;
  }
  const paidCents = incomeCents;
  const debtCents = Math.max(0, accruedCents - paidCents);
  const profitCents = incomeCents - expenseCents - refundCents;
  const participantCount = activeRegistrations.length;
  const plannedIncomeLines = budgetLines.filter((item) => item.direction === "income");
  const plannedIncomeCents = plannedIncomeLines.length
    ? plannedIncomeLines.reduce((sum, item) => sum + cents(item.plannedAmount), 0)
    : cents(moneyValue(event.defaultFee) * moneyValue(event.capacity));
  const plannedExpenseCents = budgetLines
    .filter((item) => item.direction === "expense")
    .reduce((sum, item) => sum + cents(item.plannedAmount), 0);

  const accrued = fromCents(accruedCents);
  const depositApplied = fromCents(depositCents);
  const paid = fromCents(paidCents);
  const debt = fromCents(debtCents);
  const refunds = fromCents(refundCents);
  const plannedIncome = fromCents(plannedIncomeCents);
  const plannedExpenses = fromCents(plannedExpenseCents);
  const actualIncome = fromCents(incomeCents);
  const directExpenses = fromCents(expenseCents);
  const profit = fromCents(profitCents);
  const plannedProfit = plannedIncome - plannedExpenses;
  const plannedParticipantCount = Number(event.capacity || 0);

  return {
    participantCount,
    accrued,
    depositApplied,
    paid,
    debt,
    refunds,
    plannedIncome,
    plannedExpenses,
    plannedProfit,
    plannedMargin: plannedIncome ? plannedProfit / plannedIncome : null,
    plannedProfitPerParticipant: plannedParticipantCount ? plannedProfit / plannedParticipantCount : null,
    actualIncome,
    directExpenses,
    profit,
    margin: actualIncome ? profit / actualIncome : null,
    profitPerParticipant: participantCount ? profit / participantCount : null,
  };
}

export function eventSettlementSnapshot(event, data, completedAt = Date.now()) {
  const economy = eventEconomy(event, data);
  const shares = ownerSharesForEvent(event, data);
  const profitCents = cents(economy.profit);
  let distributedCents = 0;
  const ownerShares = shares.map((share, index) => {
    const amountCents = index === shares.length - 1
      ? profitCents - distributedCents
      : signedRound(profitCents * share.share);
    distributedCents += amountCents;
    return { ...share, amount: fromCents(amountCents) };
  });
  return {
    ...economy,
    ownerShares,
    completedAt,
  };
}

export function allocatedFinanceAmount(financeId, allocations, ignoreId = "") {
  return (allocations || [])
    .filter((item) => item.financeId === financeId && item.id !== ignoreId)
    .reduce((sum, item) => sum + moneyValue(item.amount), 0);
}

export function eventRecordError(entity, item, data, ignoreId = "") {
  if (!EVENT_ENTITIES.includes(entity)) return null;
  const businessId = scopeOf(item);
  if (!businessId) return "Не указан бизнес";
  if (item.businessId && item.unit && item.businessId !== item.unit) return "businessId и unit должны совпадать";

  if (entity === "eventTypes") {
    if (!String(item.name || "").trim()) return "Укажите название типа события";
    if (typeof item.active !== "boolean") return "Статус типа события должен быть логическим";
    if (!nonNegative(item.defaultFee)) return "Взнос по умолчанию должен быть неотрицательным числом";
    if (!nonNegative(item.staffRate)) return "Ставка сотрудника должна быть неотрицательным числом";
    if (!moneyPrecision(item.defaultFee) || !moneyPrecision(item.staffRate)) return "Денежные суммы указываются с точностью до копеек";
    if (!Array.isArray(item.ownerShares)) return "Доли события должны быть списком";
    const seen = new Set();
    let total = 0;
    for (const share of item.ownerShares) {
      const ownerId = String(share?.ownerId || "");
      const value = Number(share?.share);
      if (!ownerId || seen.has(ownerId)) return "Участники распределения не должны повторяться";
      if (!Number.isFinite(value) || value < 0 || value > 1) return "Доля события должна быть числом от 0 до 1";
      const owner = sameBusinessRecord(data.businessOwners, share.ownerRecordId, businessId)
        || (data.businessOwners || []).find((candidate) => scopeOf(candidate) === businessId && candidate.ownerId === ownerId);
      if (!owner) return "Участник распределения не найден в этом бизнесе";
      seen.add(ownerId);
      total += value;
    }
    if (item.ownerShares.length && Math.abs(total - 1) > 0.0001) return "Доли типа события должны в сумме давать 100%";
    if (!item.ownerShares.length) {
      const fallback = (data.businessOwners || []).filter((owner) => owner.active !== false && scopeOf(owner) === businessId);
      const fallbackTotal = fallback.reduce((sum, owner) => sum + Number(owner.share || 0), 0);
      if (!fallback.length || Math.abs(fallbackTotal - 1) > 0.0001) {
        return "Настройте доли участников бизнеса: в сумме должно быть 100%";
      }
    }
  }

  if (entity === "events") {
    if (!String(item.title || "").trim()) return "Укажите название события";
    if (!EVENT_STATUSES.includes(String(item.status || ""))) return "Неизвестный статус события";
    if (!["open", "closed"].includes(String(item.settlementStatus || ""))) return "Неизвестный статус расчёта события";
    if (!String(item.startsAt || "").trim() || Number.isNaN(Date.parse(item.startsAt))) return "Укажите дату и время события";
    if (item.endsAt && (Number.isNaN(Date.parse(item.endsAt)) || Date.parse(item.endsAt) < Date.parse(item.startsAt))) {
      return "Дата окончания должна быть позже начала";
    }
    const type = sameBusinessRecord(data.eventTypes, item.eventTypeId, businessId);
    if (!type) return "Тип события не найден в этом бизнесе";
    if (item.venueId && !sameBusinessRecord(data.venues, item.venueId, businessId)) return "Площадка не найдена в этом бизнесе";
    if (item.responsibleId && !(data.memberships || []).some((membership) =>
      membership.employeeId === item.responsibleId && membership.active !== false && scopeOf(membership) === businessId
    )) return "У ответственного нет доступа к этому бизнесу";
    if (!nonNegative(item.defaultFee)) return "Стоимость участия должна быть неотрицательным числом";
    if (!moneyPrecision(item.defaultFee)) return "Денежные суммы указываются с точностью до копеек";
    if (!nonNegative(item.capacity) || !Number.isInteger(Number(item.capacity))) return "Вместимость должна быть целым числом не меньше нуля";
  }

  if (["eventRegistrations", "eventBudgetLines", "eventFinanceAllocations"].includes(entity)) {
    const event = eventOf(data, item);
    if (!event) return "Событие не найдено в этом бизнесе";
    if (event.settlementStatus === "closed") return "Закрытый расчёт события нельзя изменять";
  }

  if (entity === "eventRegistrations") {
    if (!REGISTRATION_STATUSES.includes(String(item.status || ""))) return "Неизвестный статус регистрации";
    if (!PARTICIPANT_TYPES.includes(String(item.participantType || ""))) return "Неизвестный тип участника";
    const participantEntity = { player: "players", company: "companies", contact: "contacts" }[item.participantType];
    const participant = sameBusinessRecord(data[participantEntity], item.participantId, businessId);
    if (!participant) return "Участник не найден в этом бизнесе";
    if (!nonNegative(item.chargeAmount)) return "Начисление должно быть неотрицательным числом";
    if (!moneyPrecision(item.chargeAmount)) return "Денежные суммы указываются с точностью до копеек";
    const before = (data.eventRegistrations || []).find((candidate) => candidate.id === ignoreId);
    if (before && before.eventId !== item.eventId) return "Нельзя переносить регистрацию в другое событие";
    if (before && (data.eventFinanceAllocations || []).some((allocation) => allocation.registrationId === before.id)
      && ["eventId", "participantType", "participantId"].some((key) => before[key] !== item[key])) {
      return "Нельзя изменить событие или участника регистрации со связанной оплатой";
    }
    if ((data.eventRegistrations || []).some((candidate) => candidate.id !== ignoreId
      && candidate.eventId === item.eventId && candidate.participantType === item.participantType
      && candidate.participantId === item.participantId)) return "Участник уже зарегистрирован на это событие";
  }

  if (entity === "eventBudgetLines") {
    if (!String(item.name || "").trim()) return "Укажите название строки бюджета";
    if (!["income", "expense"].includes(String(item.direction || ""))) return "Неизвестное направление бюджета";
    if (!nonNegative(item.plannedAmount)) return "Плановая сумма должна быть неотрицательным числом";
    if (!moneyPrecision(item.plannedAmount)) return "Денежные суммы указываются с точностью до копеек";
    const before = (data.eventBudgetLines || []).find((candidate) => candidate.id === ignoreId);
    if (before && before.eventId !== item.eventId) return "Нельзя переносить строку бюджета в другое событие";
    if (before && (data.eventFinanceAllocations || []).some((allocation) => allocation.budgetLineId === before.id)
      && before.eventId !== item.eventId) return "Нельзя перенести связанную строку бюджета в другое событие";
  }

  if (entity === "eventFinanceAllocations") {
    if (!positive(item.amount)) return "Сумма распределения должна быть больше нуля";
    if (!moneyPrecision(item.amount)) return "Сумма распределения указывается с точностью до копеек";
    if (!["payment", "deposit", "expense", "refund"].includes(String(item.purpose || ""))) return "Неизвестное назначение распределения";
    if (!/^[A-Za-z0-9:_-]{8,160}$/.test(String(item.idempotencyKey || ""))) return "Некорректный ключ повторяемости";
    const finance = sameBusinessRecord(data.finance, item.financeId, businessId);
    if (!finance) return "Финансовая операция не найдена в этом бизнесе";
    if (["payment", "deposit"].includes(item.purpose) && finance.type !== "income") return "Оплата или депозит должны ссылаться на приход";
    if (["expense", "refund"].includes(item.purpose) && finance.type !== "expense") return "Расход или возврат должен ссылаться на списание";
    if (item.registrationId) {
      const registration = sameBusinessRecord(data.eventRegistrations, item.registrationId, businessId);
      if (!registration || registration.eventId !== item.eventId) return "Регистрация не относится к этому событию";
    }
    if (["payment", "deposit", "refund"].includes(item.purpose) && !item.registrationId) {
      return "Для оплаты, депозита или возврата укажите регистрацию участника";
    }
    if (item.budgetLineId) {
      const line = sameBusinessRecord(data.eventBudgetLines, item.budgetLineId, businessId);
      if (!line || line.eventId !== item.eventId) return "Строка бюджета не относится к этому событию";
    }
    if (cents(allocatedFinanceAmount(item.financeId, data.eventFinanceAllocations, ignoreId)) + cents(item.amount) > cents(finance.amount)) {
      return "Нельзя распределить больше суммы финансовой операции";
    }
  }

  return null;
}

export function eventDeleteError(entity, item, data) {
  if (!EVENT_ENTITIES.includes(entity)) return null;
  if (entity === "eventFinanceAllocations") return "Финансовые распределения нельзя изменять или удалять";
  if (entity === "events") {
    if (item.status === "completed" || item.settlementStatus === "closed") return "Завершённое событие нельзя удалить";
    if (["eventRegistrations", "eventBudgetLines", "eventFinanceAllocations"].some((name) =>
      (data[name] || []).some((record) => record.eventId === item.id)
    )) return "У события уже есть участники, бюджет или финансовая история";
  }
  if (entity === "eventTypes" && (data.events || []).some((event) => event.eventTypeId === item.id)) {
    return "Тип события уже используется. Его можно выключить, но нельзя удалить";
  }
  if (["eventRegistrations", "eventBudgetLines"].includes(entity)) {
    const event = (data.events || []).find((candidate) => candidate.id === item.eventId);
    if (event?.settlementStatus === "closed") return "Закрытый расчёт события нельзя изменять";
  }
  if (entity === "eventRegistrations" && (data.eventFinanceAllocations || []).some((allocation) => allocation.registrationId === item.id)) {
    return "Регистрацию со связанной оплатой нельзя удалить";
  }
  if (entity === "eventBudgetLines" && (data.eventFinanceAllocations || []).some((allocation) => allocation.budgetLineId === item.id)) {
    return "Строку бюджета со связанной финансовой операцией нельзя удалить";
  }
  return null;
}
