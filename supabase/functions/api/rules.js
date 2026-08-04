export const ENTITIES = [
  "businesses", "memberships", "businessOwners",
  "employees", "clients", "venues", "players",
  "tasks", "finance", "staffExpenses", "cash", "notifications",
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
  const scopedItems = (items) => (items || []).filter((item) => canSeeItem(access, item));
  const sharesBusiness = (leftId, rightId) => {
    const left = accessSet(memberships, leftId);
    return activeMemberships(memberships, rightId).some((membership) => left.has(businessIdOf(membership)));
  };

  return {
    businesses: (data.businesses || []).filter((business) => business.active !== false && access.has(business.id)),
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
    staffExpenses: scopedItems(data.staffExpenses).filter((item) => admin || item.employeeId === user.id),
    cash: admin ? data.cash : data.cash.filter((item) => item.employeeId === user.id),
    bankBalance: admin ? bankBalance : null,
    notifications: data.notifications.filter((item) => item.toId === user.id),
  };
}

export function baseWriteError(user, entity) {
  if (!ENTITIES.includes(entity)) return "Неизвестная сущность";
  if ([...CORE_ENTITIES, "employees", "finance", "cash"].includes(entity) && !isAdmin(user)) {
    return "Только для админа";
  }
  if (entity === "notifications") return "Нельзя";
  return null;
}

export function scopeWriteError(access, item) {
  if (scopeMismatch(item)) return "businessId и unit должны совпадать";
  const businessId = businessIdOf(item);
  if (!businessId) return "Не указан бизнес";
  if (!hasBusinessAccess(access, businessId)) return "Нет доступа к этому бизнесу";
  return null;
}

export function checkWriteAccess(user, entity, item, memberships = []) {
  const baseError = baseWriteError(user, entity);
  if (baseError) return baseError;
  if (!BUSINESS_SCOPED_ENTITIES.includes(entity) && entity !== "memberships" && entity !== "businessOwners") return null;
  const fallbackMemberships = memberships.length
    ? memberships
    : legacyBusinessIds(user).map((businessId) => ({ employeeId: user.id, businessId, active: true }));
  return scopeWriteError(accessSet(fallbackMemberships, user.id), item);
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
