export const ENTITIES = [
  "businesses", "memberships", "businessOwners",
  "employees", "clients", "venues", "players",
  "tasks", "finance", "staffExpenses", "cash", "notifications", "bankTransactions",
];

export const CORE_ENTITIES = ["businesses", "memberships", "businessOwners"];
export const BUSINESS_SCOPED_ENTITIES = ["clients", "venues", "players", "tasks", "finance", "staffExpenses"];

export const DEFAULT_BUSINESSES = [
  { id: "padel", name: "Падел", emoji: "🎾", modules: ["dashboard", "tasks", "venues", "players", "finance", "money", "team"], active: true },
  { id: "dev", name: "Разработка", emoji: "💻", modules: ["dashboard", "tasks", "clients", "finance", "money", "team"], active: true },
];

export const DEFAULT_BUSINESS_OWNERS = [
  { id: "owner-dev-savva", businessId: "dev", unit: "dev", ownerId: "savva", name: "Савва", share: 0.5 },
  { id: "owner-dev-andrey", businessId: "dev", unit: "dev", ownerId: "andrey", name: "Андрей", share: 0.5 },
  { id: "owner-padel-andrey", businessId: "padel", unit: "padel", ownerId: "andrey", name: "Андрей", share: 0.34 },
  { id: "owner-padel-savva", businessId: "padel", unit: "padel", ownerId: "savva", name: "Савва", share: 0.33 },
  { id: "owner-padel-dmitry", businessId: "padel", unit: "padel", ownerId: "dmitry", name: "Дмитрий", share: 0.33 },
];

export const EXPENSE_UNITS = ["padel"];

export const isAdmin = (user) => user.role === "admin";

function equalCronSecrets(provided, configured) {
  const left = String(provided || "");
  const right = String(configured || "");
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;

  let different = 0;
  for (let i = 0; i < left.length; i++) different |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return different === 0;
}

export function tochkaSyncAccess(user, providedCronSecret, configuredCronSecret) {
  if (user && isAdmin(user)) return "admin";
  if (equalCronSecrets(providedCronSecret, configuredCronSecret)) return "cron";
  return null;
}

export const canSeeUnit = (user, unit) =>
  isAdmin(user) || user.unit === "all" || user.unit === unit;

export const businessIdOf = (item) => String(item?.businessId || item?.unit || "");

export const scopeMismatch = (item) =>
  !!(item?.businessId && item?.unit && item.businessId !== item.unit);

export function normalizeScope(item, fallback = "") {
  if (scopeMismatch(item)) return null;
  const businessId = String(item?.businessId || item?.unit || fallback);
  if (!businessId || businessId === "all") return { ...item };
  return { ...item, businessId, unit: businessId };
}

export function legacyBusinessIds(employee) {
  if (employee.role === "admin" || employee.unit === "all") return DEFAULT_BUSINESSES.map((business) => business.id);
  return employee.unit ? [String(employee.unit)] : [];
}

export function bootstrapBusinessIds(employee, businesses) {
  if (employee.active !== false && employee.role === "admin") {
    return (businesses || []).filter((business) => business.active !== false).map((business) => business.id);
  }
  return legacyBusinessIds(employee);
}

export const activeMemberships = (memberships, employeeId) =>
  (memberships || []).filter((membership) => membership.employeeId === employeeId && membership.active !== false);

export const accessSet = (memberships, employeeId) =>
  new Set(activeMemberships(memberships, employeeId).map(businessIdOf));

export const hasBusinessAccess = (access, businessId) =>
  !!businessId && businessId !== "all" && access.has(String(businessId));

export const canSeeItem = (access, item) => hasBusinessAccess(access, businessIdOf(item));

export const profileOf = (user, memberships = []) => ({
  id: user.id,
  name: user.name,
  role: user.role,
  unit: user.unit,
  phone: user.phone,
  tg: user.tg,
  businessIds: memberships.length ? [...accessSet(memberships, user.id)] : legacyBusinessIds(user),
});

export function visibleBootstrapData(user, data, bankBalance = null) {
  const admin = isAdmin(user);
  const memberships = data.memberships || [];
  const access = accessSet(memberships, user.id);
  const activeBusinessIds = new Set((data.businesses || [])
    .filter((business) => business.active !== false)
    .map((business) => business.id));
  const scopedItems = (items) => (items || []).filter((item) =>
    activeBusinessIds.has(businessIdOf(item)) && canSeeItem(access, item)
  );
  const sharesBusiness = (leftId, rightId) => {
    const left = accessSet(memberships, leftId);
    return activeMemberships(memberships, rightId).some((membership) => left.has(businessIdOf(membership)));
  };

  return {
    businesses: (data.businesses || []).filter((business) =>
      access.has(business.id) && (admin || business.active !== false)
    ),
    memberships: admin ? memberships : memberships.filter((membership) => membership.employeeId === user.id),
    businessOwners: admin ? (data.businessOwners || []) : [],
    employees: admin
      ? data.employees
      : data.employees
        .filter((employee) => employee.id === user.id || employee.role === "admin" || sharesBusiness(user.id, employee.id))
        .map((employee) => ({
          id: employee.id,
          name: employee.name,
          role: employee.role,
          unit: employee.unit,
          active: employee.active,
        })),
    clients: scopedItems(data.clients),
    venues: scopedItems(data.venues),
    players: scopedItems(data.players),
    tasks: scopedItems(data.tasks).filter((task) => admin || task.assigneeId === user.id),
    finance: scopedItems(data.finance).filter((item) => admin || item.employeeId === user.id),
    bankTransactions: admin ? (data.bankTransactions || []) : [],
    staffExpenses: scopedItems(data.staffExpenses).filter((item) => admin || item.employeeId === user.id),
    cash: admin ? data.cash : data.cash.filter((item) => item.employeeId === user.id),
    bankBalance: admin ? bankBalance : null,
    notifications: data.notifications.filter((item) => item.toId === user.id),
  };
}

export function baseWriteError(user, entity) {
  if (entity === "bankTransactions") return "Банковскую операцию можно только провести";
  if (!ENTITIES.includes(entity)) return "Неизвестная сущность";
  if ([...CORE_ENTITIES, "employees", "finance", "cash"].includes(entity) && !isAdmin(user)) {
    return "Только для админа";
  }
  if (entity === "notifications") return "Нельзя";
  return null;
}

/** @param {Array<{ id?: unknown, active?: unknown }> | null} businesses */
export function scopeWriteError(access, item, businesses = null) {
  if (scopeMismatch(item)) return "businessId и unit должны совпадать";
  const businessId = businessIdOf(item);
  if (!businessId) return "Не указан бизнес";
  if (!hasBusinessAccess(access, businessId)) return "Нет доступа к этому бизнесу";
  if (Array.isArray(businesses) && !businesses.some((business) => business.id === businessId && business.active !== false)) {
    return "Бизнес в архиве";
  }
  return null;
}

/** @param {Array<{ id?: unknown, active?: unknown }> | null} businesses */
export function checkWriteAccess(user, entity, item, memberships = [], businesses = null) {
  const baseError = baseWriteError(user, entity);
  if (baseError) return baseError;
  if (!BUSINESS_SCOPED_ENTITIES.includes(entity) && entity !== "memberships" && entity !== "businessOwners") return null;
  const fallbackMemberships = memberships.length
    ? memberships
    : legacyBusinessIds(user).map((businessId) => ({ employeeId: user.id, businessId, active: true }));
  return scopeWriteError(accessSet(fallbackMemberships, user.id), item, businesses);
}

export function validateCoreEntity(entity, item, data, ignoreId = "") {
  if (entity === "businesses") {
    const id = String(item?.id || "").trim();
    if (!id || ["all", "personal", "total"].includes(id) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
      return "ID бизнеса должен быть безопасным slug";
    }
    if ((data.businesses || []).some((business) => business.id === id && business.id !== ignoreId)) {
      return "Бизнес с таким ID уже существует";
    }
    if (!String(item?.name || "").trim()) return "Не указано название бизнеса";
    if (!Array.isArray(item?.modules)) return "Модули бизнеса должны быть списком";
    if (typeof item?.active !== "boolean") return "Статус бизнеса должен быть логическим";
  }

  if (entity === "memberships") {
    const businessId = businessIdOf(item);
    if (!(data.businesses || []).some((business) => business.id === businessId)) return "Бизнес не найден";
    if (!(data.employees || []).some((employee) => employee.id === item?.employeeId)) return "Сотрудник не найден";
    if (!["owner", "manager", "staff"].includes(String(item?.role || ""))) return "Неизвестная роль доступа";
    if ((data.memberships || []).some((membership) =>
      membership.id !== ignoreId && membership.employeeId === item.employeeId && businessIdOf(membership) === businessId
    )) return "Доступ сотрудника к этому бизнесу уже существует";
  }

  if (entity === "businessOwners") {
    const businessId = businessIdOf(item);
    const ownerId = String(item?.ownerId || "").trim();
    const share = Number(item?.share);
    if (!(data.businesses || []).some((business) => business.id === businessId)) return "Бизнес не найден";
    if (!ownerId) return "Не указан участник бизнеса";
    if (item?.share === "" || item?.share === null || !Number.isFinite(share) || share < 0 || share > 1) {
      return "Доля должна быть числом от 0 до 1";
    }
    if ((data.businessOwners || []).some((owner) =>
      owner.id !== ignoreId && owner.ownerId === ownerId && businessIdOf(owner) === businessId
    )) return "Участник уже добавлен в этот бизнес";
  }

  return null;
}

export function classifyMethod(transaction) {
  const typeCode = String(transaction.transactionTypeCode || "");
  if (/Банковские карты/i.test(typeCode)) return "card";
  if (/Денежный чек|взнос наличными/i.test(typeCode)) return "cash";

  const side = transaction.creditDebitIndicator === "Credit"
    ? transaction.DebtorAccount
    : transaction.CreditorAccount;
  const scheme = side?.schemeName || "";
  if (scheme === "RU.CBR.PAN") return "card";
  if (scheme === "RU.CBR.CellphoneNumber") return "sbp";

  const description = String(transaction.description || "").toLowerCase();
  if (/сбп|c2b|нспк|быстрых платежей|qr/.test(description)) return "sbp";
  if (/карт|терминал|pos/.test(description)) return "card";
  if (/наличн|банкомат|atm/.test(description)) return "cash";
  return "account";
}

export function bankTransactionId(transaction) {
  const amount = Number(transaction.Amount?.amount) || 0;
  return String(
    transaction.transactionId ||
    transaction.paymentId ||
    `${transaction.documentNumber || ""}|${amount}|${transaction.documentProcessDate}`,
  );
}

export function acceptBankTransaction(transaction, knownBankIds) {
  if (transaction.status === "Pending") return null;
  const bankId = bankTransactionId(transaction);
  if (knownBankIds.has(bankId)) return null;
  knownBankIds.add(bankId);
  return { bankId, amount: Number(transaction.Amount?.amount) || 0 };
}

const UTC_DAY_MS = 864e5;

function utcDateValue(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const value = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(value) || formatUtcDate(value) !== date) return NaN;
  return value;
}

function formatUtcDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function validDocumentProcessDate(value) {
  const date = typeof value === "string" ? value : "";
  return Number.isFinite(utcDateValue(date)) ? date : null;
}

// Диагностика намеренно содержит только даты и количества. В неё нельзя
// добавлять операции, суммы, контрагентов, счета или банковские идентификаторы.
export function statementRangeDiagnostics(requestedStart, requestedEnd, transactions) {
  const safeRequestedStart = validDocumentProcessDate(requestedStart);
  const safeRequestedEnd = validDocumentProcessDate(requestedEnd);
  const list = Array.isArray(transactions) ? transactions : [];
  let earliestDate = null;
  let latestDate = null;
  let missingDateCount = 0;
  let outsideRange = 0;

  for (const transaction of list) {
    const date = validDocumentProcessDate(transaction?.documentProcessDate);
    if (!date) {
      missingDateCount++;
      continue;
    }
    if (!earliestDate || date < earliestDate) earliestDate = date;
    if (!latestDate || date > latestDate) latestDate = date;
    if (!safeRequestedStart || !safeRequestedEnd || date < safeRequestedStart || date > safeRequestedEnd) {
      outsideRange++;
    }
  }

  return {
    requestedStart: safeRequestedStart,
    requestedEnd: safeRequestedEnd,
    count: list.length,
    earliestDate,
    latestDate,
    missingDateCount,
    outsideRange,
  };
}

// Диапазоны выписки включают обе границы, поэтому правая половина начинается
// со следующего календарного дня и не повторяет операции из левой половины.
export function splitStatementRange(startDate, endDate) {
  const start = utcDateValue(startDate);
  const end = utcDateValue(endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return null;

  const days = Math.round((end - start) / UTC_DAY_MS);
  const leftEnd = start + Math.floor(days / 2) * UTC_DAY_MS;
  return [
    { startDate: formatUtcDate(start), endDate: formatUtcDate(leftEnd) },
    { startDate: formatUtcDate(leftEnd + UTC_DAY_MS), endDate: formatUtcDate(end) },
  ];
}

// Текущий счёт получает весь оставшийся глобальный бюджет кроме одного
// стартового запроса на каждый следующий счёт. Неиспользованный остаток
// автоматически становится доступен следующей итерации.
export function statementRequestBudget(maxRequests, requested, remainingAccounts) {
  const total = Math.max(0, Math.floor(Number(maxRequests) || 0));
  const used = Math.max(0, Math.floor(Number(requested) || 0));
  const accounts = Math.max(0, Math.floor(Number(remainingAccounts) || 0));
  if (accounts === 0) return 0;
  return Math.max(0, total - used - (accounts - 1));
}

// Точка может вернуть ровно 100 операций без признака продолжения. Такой ответ
// для многодневного периода перепроверяем двумя непересекающимися половинами.
// Ограничения не дают ошибочному ответу банка породить бесконечное число запросов.
export async function collectStatementTransactions({
  startDate,
  endDate,
  fetchRange,
  transactionLimit = 100,
  maxDepth = 8,
  maxRequests = 32,
  deadline = Infinity,
}) {
  const transactionsById = new Map();
  const diagnostics = {
    requested: 0,
    ready: 0,
    empty: 0,
    notReady: 0,
    failed: 0,
    split: 0,
    truncated: 0,
    inconsistentSplit: 0,
    requestLimitReached: 0,
    depthLimitReached: 0,
    deadlineReached: 0,
    usable: 0,
    outsideRange: 0,
    ranges: [],
    overall: { rawSeen: 0, uniqueSeen: 0, earliest: null, latest: null },
  };

  const root = {
    startDate,
    endDate,
    depth: 0,
    ids: new Set(),
    children: null,
    complete: false,
    rangeValid: true,
  };
  const queue = [root];

  // Обход по уровням использует единый расходуемый бюджет. Поэтому пустая ветка
  // не удерживает заранее выделенные запросы, а обе половины развиваются справедливо.
  while (queue.length) {
    if (Date.now() >= deadline) {
      diagnostics.truncated += queue.length;
      diagnostics.deadlineReached++;
      break;
    }
    if (diagnostics.requested >= maxRequests) {
      diagnostics.truncated += queue.length;
      diagnostics.requestLimitReached++;
      break;
    }

    const node = queue.shift();
    diagnostics.requested++;
    let statement;
    try {
      statement = await fetchRange(node.startDate, node.endDate);
    } catch (_error) {
      diagnostics.ranges.push(statementRangeDiagnostics(node.startDate, node.endDate, []));
      diagnostics.failed++;
      continue;
    }

    if (statement?.status === "Deadline") {
      diagnostics.ranges.push(statementRangeDiagnostics(node.startDate, node.endDate, []));
      diagnostics.truncated++;
      diagnostics.deadlineReached++;
      continue;
    }
    if (!statement || (statement.status !== "Ready" && statement.status !== "Error")) {
      diagnostics.ranges.push(statementRangeDiagnostics(node.startDate, node.endDate, []));
      diagnostics.notReady++;
      continue;
    }
    if (statement.status === "Error") {
      diagnostics.ranges.push(statementRangeDiagnostics(node.startDate, node.endDate, []));
      diagnostics.failed++;
      continue;
    }

    diagnostics.ready++;
    diagnostics.usable++;
    const rangeTransactions = Array.isArray(statement.Transaction) ? statement.Transaction : [];
    const rangeDiagnostics = statementRangeDiagnostics(node.startDate, node.endDate, rangeTransactions);
    diagnostics.ranges.push(rangeDiagnostics);
    diagnostics.overall.rawSeen += rangeDiagnostics.count;
    diagnostics.outsideRange += rangeDiagnostics.outsideRange;
    node.rangeValid = rangeDiagnostics.outsideRange === 0 && rangeDiagnostics.missingDateCount === 0;
    if (!node.rangeValid) diagnostics.truncated++;
    if (
      rangeDiagnostics.earliestDate &&
      (!diagnostics.overall.earliest || rangeDiagnostics.earliestDate < diagnostics.overall.earliest)
    ) diagnostics.overall.earliest = rangeDiagnostics.earliestDate;
    if (
      rangeDiagnostics.latestDate &&
      (!diagnostics.overall.latest || rangeDiagnostics.latestDate > diagnostics.overall.latest)
    ) diagnostics.overall.latest = rangeDiagnostics.latestDate;
    for (const transaction of rangeTransactions) {
      const transactionId = bankTransactionId(transaction);
      node.ids.add(transactionId);
      // Более узкий диапазон обрабатывается позже и может содержать более свежий
      // статус той же операции, поэтому заменяет родительскую версию.
      transactionsById.set(transactionId, transaction);
    }

    if (rangeTransactions.length >= transactionLimit) {
      const halves = splitStatementRange(node.startDate, node.endDate);
      const hasBudgetForBothHalves = diagnostics.requested + queue.length + 2 <= maxRequests;
      if (halves && node.depth < maxDepth && hasBudgetForBothHalves) {
        diagnostics.split++;
        node.children = halves.map((half) => ({
          ...half,
          depth: node.depth + 1,
          ids: new Set(),
          children: null,
          complete: false,
          rangeValid: true,
        }));
        queue.push(...node.children);
        continue;
      }
      if (halves && node.depth >= maxDepth) diagnostics.depthLimitReached++;
      else if (halves) diagnostics.requestLimitReached++;
      if (node.rangeValid) diagnostics.truncated++;
      continue;
    }

    if (!rangeTransactions.length) diagnostics.empty++;
    node.complete = node.rangeValid;
  }

  // Проверяем покрытие снизу вверх. Родительские операции уже сохранены в Map,
  // но несовпадение с полностью готовыми листьями всё равно означает partial.
  function subtree(node) {
    if (!node.children) return { complete: node.complete, ids: new Set(node.ids) };
    const children = node.children.map(subtree);
    if (!children.every((child) => child.complete)) return { complete: false, ids: new Set(node.ids) };
    const childIds = new Set(children.flatMap((child) => [...child.ids]));
    const inconsistent = [...node.ids].some((id) => !childIds.has(id));
    if (inconsistent) {
      diagnostics.inconsistentSplit++;
      diagnostics.truncated++;
    }
    return { complete: node.rangeValid && !inconsistent, ids: childIds };
  }
  subtree(root);
  diagnostics.overall.uniqueSeen = transactionsById.size;

  return { transactions: [...transactionsById.values()], diagnostics };
}

export function bankSyncResult(diagnostics, added) {
  const processed = diagnostics.accounts.processed;
  const errors = diagnostics.errors;
  let outcome = "completed";

  if (processed === 0 && errors > 0) outcome = "failed";
  else if (errors > 0) outcome = "partial";
  else if (diagnostics.transactions.seen === 0) outcome = "zero_transactions";
  else if (
    added === 0 &&
    diagnostics.transactions.pending === 0 &&
    diagnostics.transactions.duplicates === diagnostics.transactions.seen
  ) outcome = "all_duplicates";
  else if (added === 0) outcome = "no_new_transactions";

  return {
    ok: processed > 0 || errors === 0,
    added,
    outcome,
    diagnostics,
  };
}

export function sumBankBalances(balances) {
  const bestByAccount = new Map();
  const rank = (type) => (type === "ClosingAvailable" ? 3 : type === "Expected" ? 2 : 1);

  for (const balance of balances) {
    const accountId = String(balance.accountId || "?");
    const current = bestByAccount.get(accountId);
    if (!current || rank(balance.type) > rank(current.type)) bestByAccount.set(accountId, balance);
  }

  let total = 0;
  for (const balance of bestByAccount.values()) total += Number(balance.Amount?.amount) || 0;
  return total;
}
