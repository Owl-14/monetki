export const ENTITIES = [
  "employees", "clients", "venues", "players",
  "tasks", "finance", "staffExpenses", "cash", "notifications",
];

export const EXPENSE_UNITS = ["padel"];

export const isAdmin = (user) => user.role === "admin";

export const canSeeUnit = (user, unit) =>
  isAdmin(user) || user.unit === "all" || user.unit === unit;

export const profileOf = (user) => ({
  id: user.id,
  name: user.name,
  role: user.role,
  unit: user.unit,
  phone: user.phone,
  tg: user.tg,
});

export function visibleBootstrapData(user, data, bankBalance = null) {
  const admin = isAdmin(user);
  const unitItems = (items) => items.filter((item) => canSeeUnit(user, item.unit));

  return {
    employees: admin
      ? data.employees
      : data.employees
        .filter((employee) => employee.unit === user.unit || employee.unit === "all" || employee.role === "admin")
        .map((employee) => ({
          id: employee.id,
          name: employee.name,
          role: employee.role,
          unit: employee.unit,
          active: employee.active,
        })),
    clients: unitItems(data.clients),
    venues: unitItems(data.venues),
    players: unitItems(data.players),
    tasks: admin ? data.tasks : unitItems(data.tasks).filter((task) => task.assigneeId === user.id),
    finance: admin ? data.finance : data.finance.filter((item) => item.employeeId === user.id),
    staffExpenses: admin ? data.staffExpenses : data.staffExpenses.filter((item) => item.employeeId === user.id),
    cash: admin ? data.cash : data.cash.filter((item) => item.employeeId === user.id),
    bankBalance: admin ? bankBalance : null,
    notifications: data.notifications.filter((item) => item.toId === user.id),
  };
}

export function checkWriteAccess(user, entity, item) {
  if (!ENTITIES.includes(entity)) return "Неизвестная сущность";
  if ((entity === "employees" || entity === "finance" || entity === "cash") && !isAdmin(user)) {
    return "Только для админа";
  }
  if (entity === "notifications") return "Нельзя";
  if (item?.unit && item.unit !== "all" && !canSeeUnit(user, item.unit)) {
    return "Нет доступа к этому направлению";
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
