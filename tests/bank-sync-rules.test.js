import test from "node:test";
import assert from "node:assert/strict";

import {
  acceptBankTransaction,
  bankSyncResult,
  bankTransactionId,
  classifyMethod,
  collectStatementTransactions,
  splitStatementRange,
  statementRangeDiagnostics,
  statementRequestBudget,
  sumBankBalances,
} from "../supabase/functions/api/rules.js";

test("bankId отсекает запись из базы и дубль внутри одной синхронизации", () => {
  const known = new Set(["already-saved"]);

  assert.equal(acceptBankTransaction({ transactionId: "already-saved" }, known), null);
  assert.deepEqual(
    acceptBankTransaction({ transactionId: "new", Amount: { amount: "125.50" } }, known),
    { bankId: "new", amount: 125.5 },
  );
  assert.equal(acceptBankTransaction({ transactionId: "new", Amount: { amount: "125.50" } }, known), null);
});

test("Pending-операция не резервирует bankId и может прийти готовой позже", () => {
  const known = new Set();
  assert.equal(acceptBankTransaction({ transactionId: "later", status: "Pending" }, known), null);
  assert.equal(known.has("later"), false);
  assert.deepEqual(acceptBankTransaction({ transactionId: "later", status: "Booked" }, known), {
    bankId: "later",
    amount: 0,
  });
});

test("запасной bankId детерминирован из документа, суммы и даты", () => {
  const transaction = {
    documentNumber: "42",
    documentProcessDate: "2026-08-02",
    Amount: { amount: "1000" },
  };
  assert.equal(bankTransactionId(transaction), "42|1000|2026-08-02");
});

test("способ оплаты классифицируется по коду, схеме и описанию", () => {
  assert.equal(classifyMethod({ transactionTypeCode: "Банковские карты" }), "card");
  assert.equal(classifyMethod({ transactionTypeCode: "взнос наличными" }), "cash");
  assert.equal(classifyMethod({ creditDebitIndicator: "Credit", DebtorAccount: { schemeName: "RU.CBR.CellphoneNumber" } }), "sbp");
  assert.equal(classifyMethod({ creditDebitIndicator: "Debit", CreditorAccount: { schemeName: "RU.CBR.PAN" } }), "card");
  assert.equal(classifyMethod({ description: "Оплата по QR через НСПК" }), "sbp");
  assert.equal(classifyMethod({ description: "Обычный банковский перевод" }), "account");
});

test("баланс выбирает лучший тип по каждому счёту и сохраняет знак банка", () => {
  const total = sumBankBalances([
    { accountId: "a", type: "Expected", Amount: { amount: "100" } },
    { accountId: "a", type: "ClosingAvailable", Amount: { amount: "-25" } },
    { accountId: "b", type: "InterimAvailable", Amount: { amount: "10" } },
  ]);

  assert.equal(total, -15);
});

test("диапазон выписки делится по календарным дням без пересечения", () => {
  assert.deepEqual(splitStatementRange("2026-07-01", "2026-07-30"), [
    { startDate: "2026-07-01", endDate: "2026-07-15" },
    { startDate: "2026-07-16", endDate: "2026-07-30" },
  ]);
  assert.deepEqual(splitStatementRange("2026-07-19", "2026-07-20"), [
    { startDate: "2026-07-19", endDate: "2026-07-19" },
    { startDate: "2026-07-20", endDate: "2026-07-20" },
  ]);
  assert.equal(splitStatementRange("2026-07-19", "2026-07-19"), null);
  assert.equal(splitStatementRange("2026-02-30", "2026-03-02"), null);
});

test("диагностика диапазона принимает только реальные даты YYYY-MM-DD и не раскрывает операции", () => {
  const diagnostics = statementRangeDiagnostics("2026-07-20", "2026-07-21", [
    {
      documentProcessDate: "2026-07-20",
      transactionId: "SECRET_TRANSACTION",
      bankId: "SECRET_BANK_ID",
      accountId: "SECRET_ACCOUNT",
      Amount: { amount: "SECRET_AMOUNT" },
      DebtorParty: { name: "SECRET_COUNTERPARTY" },
      description: "SECRET_DESCRIPTION",
    },
    { documentProcessDate: "2026-07-22" },
    { documentProcessDate: "2026-02-30" },
    { documentProcessDate: "2026-07-21T12:00:00Z" },
    {},
  ]);

  assert.deepEqual(diagnostics, {
    requestedStart: "2026-07-20",
    requestedEnd: "2026-07-21",
    count: 5,
    earliestDate: "2026-07-20",
    latestDate: "2026-07-22",
    missingDateCount: 3,
    outsideRange: 1,
  });
  assert.deepEqual(Object.keys(diagnostics), [
    "requestedStart", "requestedEnd", "count", "earliestDate",
    "latestDate", "missingDateCount", "outsideRange",
  ]);
  const serialized = JSON.stringify(diagnostics);
  for (const secret of [
    "SECRET_TRANSACTION", "SECRET_BANK_ID", "SECRET_ACCOUNT", "SECRET_AMOUNT",
    "SECRET_COUNTERPARTY", "SECRET_DESCRIPTION",
  ]) assert.doesNotMatch(serialized, new RegExp(secret));

  const sanitizedRequest = statementRangeDiagnostics("SECRET_START", "SECRET_END", []);
  assert.equal(sanitizedRequest.requestedStart, null);
  assert.equal(sanitizedRequest.requestedEnd, null);
  assert.doesNotMatch(JSON.stringify(sanitizedRequest), /SECRET_/);
});

test("бюджет счёта резервирует только один root-запрос каждому следующему счёту", () => {
  assert.equal(statementRequestBudget(32, 0, 2), 31);
  assert.equal(statementRequestBudget(32, 31, 1), 1);
  assert.equal(statementRequestBudget(32, 1, 1), 31);
  assert.equal(statementRequestBudget(32, 32, 1), 0);
  assert.equal(statementRequestBudget(32, 0, 0), 0);
});

test("выписка из 100 операций рекурсивно заменяется результатами двух половин", async () => {
  const calls = [];
  const root = Array.from({ length: 100 }, (_, index) => ({
    transactionId: `root-${index}`,
    documentProcessDate: index < 50 ? "2026-07-01" : "2026-07-02",
  }));
  const result = await collectStatementTransactions({
    startDate: "2026-07-01",
    endDate: "2026-07-04",
    fetchRange: async (startDate, endDate) => {
      calls.push([startDate, endDate]);
      if (
        (startDate === "2026-07-01" && endDate === "2026-07-04") ||
        (startDate === "2026-07-01" && endDate === "2026-07-02")
      ) {
        return { status: "Ready", Transaction: root };
      }
      if (startDate === "2026-07-01" && endDate === "2026-07-01") {
        return { status: "Ready", Transaction: root.slice(0, 50) };
      }
      if (startDate === "2026-07-02" && endDate === "2026-07-02") {
        return { status: "Ready", Transaction: root.slice(50) };
      }
      return { status: "Ready", Transaction: [] };
    },
  });

  assert.deepEqual(calls, [
    ["2026-07-01", "2026-07-04"],
    ["2026-07-01", "2026-07-02"],
    ["2026-07-03", "2026-07-04"],
    ["2026-07-01", "2026-07-01"],
    ["2026-07-02", "2026-07-02"],
  ]);
  assert.deepEqual(result.transactions.map((item) => item.transactionId), root.map((item) => item.transactionId));
  assert.equal(result.diagnostics.requested, 5);
  assert.equal(result.diagnostics.split, 2);
  assert.equal(result.diagnostics.truncated, 0);
  assert.equal(result.diagnostics.inconsistentSplit, 0);
  assert.equal(result.diagnostics.usable, 5);
});

test("рассогласование половин не теряет операции родительской выписки и даёт partial", async () => {
  const root = Array.from({ length: 100 }, (_, index) => ({
    transactionId: `fallback-${index}`,
    documentProcessDate: index < 50 ? "2026-07-01" : "2026-07-02",
  }));
  const result = await collectStatementTransactions({
    startDate: "2026-07-01",
    endDate: "2026-07-02",
    fetchRange: async (startDate, endDate) => ({
      status: "Ready",
      Transaction: startDate === endDate ? [] : root,
    }),
  });

  assert.equal(result.transactions.length, 100);
  assert.equal(result.diagnostics.inconsistentSplit, 1);
  assert.equal(result.diagnostics.truncated, 1);
  assert.equal(result.diagnostics.usable, 3);
});

test("одни и те же root 100 в обеих половинах не дают ложное полное покрытие", async () => {
  const root = Array.from({ length: 100 }, (_, index) => ({
    transactionId: `same-${index}`,
    documentProcessDate: `2026-07-0${1 + Math.floor(index / 25)}`,
  }));
  const result = await collectStatementTransactions({
    startDate: "2026-07-01",
    endDate: "2026-07-04",
    maxDepth: 1,
    fetchRange: async () => ({ status: "Ready", Transaction: root }),
  });

  assert.equal(result.transactions.length, 100);
  assert.equal(result.diagnostics.requested, 3);
  assert.equal(result.diagnostics.split, 1);
  assert.equal(result.diagnostics.overall.rawSeen, 300);
  assert.equal(result.diagnostics.overall.uniqueSeen, 100);
  assert.equal(result.diagnostics.overall.earliest, "2026-07-01");
  assert.equal(result.diagnostics.overall.latest, "2026-07-04");
  assert.equal(result.diagnostics.outsideRange, 100);
  assert.deepEqual(Object.keys(result.diagnostics.overall), ["rawSeen", "uniqueSeen", "earliest", "latest"]);
  assert.equal(result.diagnostics.truncated, 2);
  assert.deepEqual(result.diagnostics.ranges.map((range) => range.outsideRange), [0, 50, 50]);

  const syncDiagnostics = diagnostics({ seen: 100, duplicates: 100, errors: result.diagnostics.truncated });
  syncDiagnostics.accounts.partial = 1;
  syncDiagnostics.statements.truncated = result.diagnostics.truncated;
  const syncResult = bankSyncResult(syncDiagnostics, 0);
  assert.equal(syncResult.outcome, "partial");
});

test("операция без валидной даты сохраняется, но не даёт ложное полное покрытие", async () => {
  const transaction = { transactionId: "missing-date", documentProcessDate: "2026-02-30" };
  const result = await collectStatementTransactions({
    startDate: "2026-07-20",
    endDate: "2026-07-20",
    fetchRange: async () => ({ status: "Ready", Transaction: [transaction] }),
  });

  assert.deepEqual(result.transactions, [transaction]);
  assert.equal(result.diagnostics.ranges[0].missingDateCount, 1);
  assert.equal(result.diagnostics.ranges[0].outsideRange, 0);
  assert.equal(result.diagnostics.truncated, 1);
});

test("общий BFS-бюджет возвращает неиспользованные запросы насыщенной правой половине", async () => {
  const allTransactions = Array.from({ length: 15 * 99 }, (_, index) => ({
    transactionId: `skew-${index}`,
    day: 16 + Math.floor(index / 99),
    documentProcessDate: `2026-07-${16 + Math.floor(index / 99)}`,
  }));
  const result = await collectStatementTransactions({
    startDate: "2026-07-01",
    endDate: "2026-07-30",
    maxRequests: 32,
    fetchRange: async (startDate, endDate) => {
      if (endDate <= "2026-07-15") return { status: "Ready", Transaction: [] };
      const firstDay = Math.max(16, Number(startDate.slice(-2)));
      const lastDay = Number(endDate.slice(-2));
      const transactions = allTransactions.filter((item) => item.day >= firstDay && item.day <= lastDay);
      return { status: "Ready", Transaction: startDate === endDate ? transactions : transactions.slice(0, 100) };
    },
  });

  assert.equal(result.diagnostics.requested, 31);
  assert.equal(result.diagnostics.split, 15);
  assert.equal(result.diagnostics.truncated, 0);
  assert.equal(result.diagnostics.requestLimitReached, 0);
  assert.equal(result.transactions.length, 15 * 99);
});

test("два счёта динамически делят 32 запроса независимо от порядка плотного счёта", async () => {
  const allTransactions = Array.from({ length: 15 * 99 }, (_, index) => ({
    transactionId: `multi-${index}`,
    day: 16 + Math.floor(index / 99),
    documentProcessDate: `2026-07-${16 + Math.floor(index / 99)}`,
  }));
  const denseFetch = async (startDate, endDate) => {
    if (endDate <= "2026-07-15") return { status: "Ready", Transaction: [] };
    const firstDay = Math.max(16, Number(startDate.slice(-2)));
    const lastDay = Number(endDate.slice(-2));
    const transactions = allTransactions.filter((item) => item.day >= firstDay && item.day <= lastDay);
    return { status: "Ready", Transaction: startDate === endDate ? transactions : transactions.slice(0, 100) };
  };
  const emptyFetch = async () => ({ status: "Ready", Transaction: [] });

  async function runAccounts(fetchers) {
    let requested = 0;
    const results = [];
    const limits = [];
    for (let index = 0; index < fetchers.length; index++) {
      const limit = statementRequestBudget(32, requested, fetchers.length - index);
      limits.push(limit);
      const result = await collectStatementTransactions({
        startDate: "2026-07-01",
        endDate: "2026-07-30",
        maxRequests: limit,
        fetchRange: fetchers[index],
      });
      requested += result.diagnostics.requested;
      results.push(result);
    }
    return { requested, results, limits };
  }

  const denseFirst = await runAccounts([denseFetch, emptyFetch]);
  assert.deepEqual(denseFirst.limits, [31, 1]);
  assert.deepEqual(denseFirst.results.map((result) => result.diagnostics.requested), [31, 1]);
  assert.equal(denseFirst.requested, 32);
  assert.equal(denseFirst.results.reduce((sum, result) => sum + result.diagnostics.truncated, 0), 0);

  const emptyFirst = await runAccounts([emptyFetch, denseFetch]);
  assert.deepEqual(emptyFirst.limits, [31, 31]);
  assert.deepEqual(emptyFirst.results.map((result) => result.diagnostics.requested), [1, 31]);
  assert.equal(emptyFirst.requested, 32);
  assert.equal(emptyFirst.results.reduce((sum, result) => sum + result.diagnostics.truncated, 0), 0);
});

test("100 операций за один день сохраняются с честной отметкой о неполноте", async () => {
  const transactions = Array.from({ length: 100 }, (_, index) => ({ transactionId: `day-${index}` }));
  const result = await collectStatementTransactions({
    startDate: "2026-07-19",
    endDate: "2026-07-19",
    fetchRange: async () => ({ status: "Ready", Transaction: transactions }),
  });

  assert.equal(result.transactions.length, 100);
  assert.equal(result.diagnostics.requested, 1);
  assert.equal(result.diagnostics.split, 0);
  assert.equal(result.diagnostics.truncated, 1);
});

test("лимит запросов останавливает дальнейшее деление и помечает partial", async () => {
  const transactions = Array.from({ length: 100 }, (_, index) => ({ transactionId: `limited-${index}` }));
  const result = await collectStatementTransactions({
    startDate: "2026-07-01",
    endDate: "2026-07-30",
    maxRequests: 2,
    fetchRange: async () => ({ status: "Ready", Transaction: transactions }),
  });

  assert.equal(result.transactions.length, 100);
  assert.equal(result.diagnostics.requested, 1);
  assert.equal(result.diagnostics.split, 0);
  assert.equal(result.diagnostics.truncated, 1);
  assert.equal(result.diagnostics.requestLimitReached, 1);
});

test("общий дедлайн прекращает запросы и не маскируется под готовую выписку", async () => {
  let fetchCalled = false;
  const result = await collectStatementTransactions({
    startDate: "2026-07-01",
    endDate: "2026-07-30",
    deadline: 0,
    fetchRange: async () => {
      fetchCalled = true;
      return { status: "Ready", Transaction: [] };
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.diagnostics.requested, 0);
  assert.equal(result.diagnostics.truncated, 1);
  assert.equal(result.diagnostics.deadlineReached, 1);
  assert.equal(result.diagnostics.usable, 0);
});

function diagnostics({ processed = 1, failed = 0, ready = processed, empty = 0, notReady = 0, seen = 0, duplicates = 0, pending = 0, errors = 0 } = {}) {
  return {
    accounts: { total: processed + failed, processed, partial: 0, failed },
    statements: { requested: processed + failed, ready, empty, notReady, failed, split: 0, truncated: 0, inconsistent: 0 },
    transactions: { seen, duplicates, pending },
    errors,
  };
}

test("диагностика отличает готовую пустую выписку", () => {
  const result = bankSyncResult(diagnostics({ empty: 1 }), 0);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "zero_transactions");
  assert.equal(result.diagnostics.statements.empty, 1);
});

test("диагностика отличает случай, когда все операции уже загружены", () => {
  const result = bankSyncResult(diagnostics({ seen: 3, duplicates: 3 }), 0);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "all_duplicates");
});

test("ошибка одного счёта даёт частичный успех, если другой обработан", () => {
  const result = bankSyncResult(diagnostics({ processed: 1, failed: 1, errors: 1 }), 0);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "partial");
  assert.equal(result.diagnostics.accounts.failed, 1);
});

test("возможное усечение выписки даёт partial даже при сохранённых операциях", () => {
  const details = diagnostics({ seen: 100, errors: 1 });
  details.accounts.partial = 1;
  details.statements.truncated = 1;
  const result = bankSyncResult(details, 100);

  assert.equal(result.ok, true);
  assert.equal(result.outcome, "partial");
  assert.equal(result.diagnostics.statements.truncated, 1);
});

test("синхронизация неуспешна, если из-за ошибок не обработан ни один счёт", () => {
  const result = bankSyncResult(diagnostics({ processed: 0, failed: 2, ready: 0, notReady: 2, errors: 2 }), 0);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "failed");
  assert.equal(result.diagnostics.statements.notReady, 2);
});
