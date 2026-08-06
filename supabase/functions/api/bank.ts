import {
  acceptBankTransaction,
  bankSyncResult,
  bankTransactionId,
  classifyMethod,
  collectStatementTransactions,
  statementRequestBudget,
  sumBankBalances,
} from "./rules.js";
import { remindDeadlines } from "./actions.ts";
import { normalizeBankSignals } from "./bank-rules.js";
import { autoProcessBankQueue, bankSignalFingerprint } from "./bank-rule-actions.ts";
import { callRpc, kvSet, readAll } from "./db/repositories.ts";
import type { Rec } from "./types.ts";

const TOCHKA = "https://enter.tochka.com/uapi";

async function hmacAccountKey(value: string) {
  const secret = Deno.env.get("BANK_SIGNAL_HMAC_SECRET") || Deno.env.get("TOCHKA_SYNC_SECRET");
  if (!secret || secret.length < 32) return "";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`account:${value}`));
  return `h1:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function bankQueueRecordId(bankId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bankId));
  return `bankq:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function tochkaFetch(path: string, init?: RequestInit) {
  const token = Deno.env.get("TOCHKA_TOKEN");
  if (!token) throw new Error("Не задан секрет TOCHKA_TOKEN");
  const resp = await fetch(TOCHKA + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`Точка API ${resp.status}`);
  return JSON.parse(body);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TOCHKA_STATEMENT_REQUEST_LIMIT = 32;
const TOCHKA_STATEMENT_SPLIT_DEPTH = 8;
const TOCHKA_SYNC_DEADLINE_MS = 150_000;
const TOCHKA_SYNC_LEASE_SECONDS = 210;

function isTochkaDeadlineError(error: unknown, deadline: number) {
  const name = (error as Error)?.name;
  return Date.now() >= deadline || name === "TimeoutError" || name === "AbortError";
}

async function acquireTochkaSyncLease() {
  const leaseId = crypto.randomUUID();
  const { data, error } = await callRpc("acquire_tochka_sync_lease", {
    p_lease_id: leaseId,
    p_lease_seconds: TOCHKA_SYNC_LEASE_SECONDS,
  });
  if (error) throw new Error("Не удалось получить аренду синхронизации");
  return data === true ? leaseId : null;
}

async function releaseTochkaSyncLease(leaseId: string) {
  const { error } = await callRpc("release_tochka_sync_lease", { p_lease_id: leaseId });
  if (error) throw new Error("Не удалось освободить аренду синхронизации");
}

async function fetchTochkaStatement(
  accountId: string,
  startDate: string,
  endDate: string,
  deadline: number,
) {
  if (Date.now() >= deadline) return { status: "Deadline" };

  let init;
  try {
    init = await tochkaFetch("/open-banking/v1.0/statements", {
      method: "POST",
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      body: JSON.stringify({
        Data: { Statement: { accountId, startDateTime: startDate, endDateTime: endDate } },
      }),
    });
  } catch (error) {
    if (isTochkaDeadlineError(error, deadline)) return { status: "Deadline" };
    throw error;
  }
  const stId = init?.Data?.Statement?.statementId;
  if (!stId) throw new Error("Точка не вернула идентификатор выписки");

  let statement: Rec | null = null;
  for (let i = 0; i < 20; i++) {
    if (i > 0) {
      const wait = Math.min(3000, deadline - Date.now());
      if (wait <= 0) return { status: "Deadline" };
      await sleep(wait);
    }
    if (Date.now() >= deadline) return { status: "Deadline" };
    let got;
    try {
      got = await tochkaFetch(
        `/open-banking/v1.0/accounts/${encodeURIComponent(accountId)}/statements/${encodeURIComponent(stId)}`,
        { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) },
      );
    } catch (error) {
      if (isTochkaDeadlineError(error, deadline)) return { status: "Deadline" };
      throw error;
    }
    const raw = got?.Data?.Statement;
    const statements: Rec[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    statement = statements.find((item) => String(item.statementId) === String(stId)) || statements[0] || null;
    if (statement && (statement.status === "Ready" || statement.status === "Error")) break;
  }
  return statement;
}

async function tochkaSync(days = 30, deadline = Date.now() + TOCHKA_SYNC_DEADLINE_MS) {
  if (Date.now() >= deadline) throw new Error("Истёк безопасный срок синхронизации");
  const accountsRes = await tochkaFetch("/open-banking/v1.0/accounts", {
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  });
  const accounts: Rec[] = accountsRes?.Data?.Account || [];
  if (!accounts.length) return { ok: false, error: "Счета не найдены" };

  const diagnostics = {
    accounts: { total: accounts.length, processed: 0, partial: 0, failed: 0 },
    statements: {
      requested: 0, ready: 0, empty: 0, notReady: 0, failed: 0,
      split: 0, truncated: 0, inconsistent: 0, outsideRange: 0,
      ranges: [] as Array<Record<string, unknown>>,
    },
    transactions: {
      seen: 0, duplicates: 0, pending: 0,
      overall: {
        rawSeen: 0,
        uniqueSeen: 0,
        earliest: null as string | null,
        latest: null as string | null,
      },
    },
    limits: {
      maxStatementRequests: TOCHKA_STATEMENT_REQUEST_LIMIT,
      maxSplitDepth: TOCHKA_STATEMENT_SPLIT_DEPTH,
      requestLimitReached: 0,
      depthLimitReached: 0,
      deadlineReached: 0,
    },
    errors: 0,
  };

  const end = new Date();
  const start = new Date(end.getTime() - days * 864e5);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const [existing, queued] = await Promise.all([readAll("finance"), readAll("bankTransactions")]);
  const known = new Set([...existing, ...queued].map((f) => f.bankId).filter(Boolean));
  const queuedByBankId = new Map(queued.filter((item) => item.bankId).map((item) => [String(item.bankId), item]));
  const syncSeenIds = new Set<string>();
  let added = 0;
  let deadlineStopped = false;

  for (let accountIndex = 0; accountIndex < accounts.length; accountIndex++) {
    const acc = accounts[accountIndex];
    const remainingRequests = TOCHKA_STATEMENT_REQUEST_LIMIT - diagnostics.statements.requested;
    if (remainingRequests <= 0) {
      diagnostics.accounts.failed++;
      diagnostics.statements.truncated++;
      diagnostics.limits.requestLimitReached++;
      diagnostics.errors++;
      continue;
    }

    // Оставляем хотя бы стартовый запрос каждому следующему счёту.
    const remainingAccounts = accounts.length - accountIndex;
    const accountRequestLimit = statementRequestBudget(
      TOCHKA_STATEMENT_REQUEST_LIMIT,
      diagnostics.statements.requested,
      remainingAccounts,
    );
    if (accountRequestLimit <= 0) {
      diagnostics.accounts.failed++;
      diagnostics.statements.truncated++;
      diagnostics.limits.requestLimitReached++;
      diagnostics.errors++;
      continue;
    }
    const accountId = String(acc.accountId);
    const collected = await collectStatementTransactions({
      startDate: fmt(start),
      endDate: fmt(end),
      maxDepth: TOCHKA_STATEMENT_SPLIT_DEPTH,
      maxRequests: accountRequestLimit,
      deadline,
      fetchRange: (rangeStart: string, rangeEnd: string) =>
        fetchTochkaStatement(accountId, rangeStart, rangeEnd, deadline),
    });
    const statementDiagnostics = collected.diagnostics;
    diagnostics.statements.requested += statementDiagnostics.requested;
    diagnostics.statements.ready += statementDiagnostics.ready;
    diagnostics.statements.empty += statementDiagnostics.empty;
    diagnostics.statements.notReady += statementDiagnostics.notReady;
    diagnostics.statements.failed += statementDiagnostics.failed;
    diagnostics.statements.split += statementDiagnostics.split;
    diagnostics.statements.truncated += statementDiagnostics.truncated;
    diagnostics.statements.inconsistent += statementDiagnostics.inconsistentSplit;
    diagnostics.statements.outsideRange += statementDiagnostics.outsideRange;
    diagnostics.statements.ranges.push(...statementDiagnostics.ranges);
    diagnostics.transactions.overall.rawSeen += statementDiagnostics.overall.rawSeen;
    const statementEarliest = statementDiagnostics.overall.earliest as string | null;
    const statementLatest = statementDiagnostics.overall.latest as string | null;
    if (
      statementEarliest &&
      (!diagnostics.transactions.overall.earliest ||
        statementEarliest < diagnostics.transactions.overall.earliest)
    ) diagnostics.transactions.overall.earliest = statementEarliest;
    if (
      statementLatest &&
      (!diagnostics.transactions.overall.latest ||
        statementLatest > diagnostics.transactions.overall.latest)
    ) diagnostics.transactions.overall.latest = statementLatest;
    diagnostics.limits.requestLimitReached += statementDiagnostics.requestLimitReached;
    diagnostics.limits.depthLimitReached += statementDiagnostics.depthLimitReached;
    diagnostics.limits.deadlineReached += statementDiagnostics.deadlineReached;

    const accountErrors = statementDiagnostics.notReady +
      statementDiagnostics.failed + statementDiagnostics.truncated;
    diagnostics.errors += accountErrors;
    if (statementDiagnostics.usable === 0) {
      diagnostics.accounts.failed++;
      continue;
    }
    diagnostics.accounts.processed++;
    let accountPartial = accountErrors > 0;
    if (accountPartial) diagnostics.accounts.partial++;

    const transactions = collected.transactions as Rec[];
    diagnostics.transactions.seen += transactions.length;
    for (const transaction of transactions) syncSeenIds.add(bankTransactionId(transaction));
    diagnostics.transactions.overall.uniqueSeen = syncSeenIds.size;

    for (const t of transactions) {
      if (Date.now() >= deadline) {
        diagnostics.limits.deadlineReached++;
        diagnostics.errors++;
        if (!accountPartial) {
          diagnostics.accounts.partial++;
          accountPartial = true;
        }
        deadlineStopped = true;
        break;
      }
      if (t.status === "Pending") {
        diagnostics.transactions.pending++;
        continue;
      }
      const transactionBankId = bankTransactionId(t);
      const detectedMethod = classifyMethod(t);
      const bankSignals = await normalizeBankSignals(t, {
        detectedMethod,
        sourceAccountId: accountId,
        accountKey: hmacAccountKey,
      });
      if (known.has(transactionBankId)) {
        diagnostics.transactions.duplicates++;
        const queuedDuplicate = queuedByBankId.get(transactionBankId);
        if (queuedDuplicate && !queuedDuplicate.bankSignals?.schemaVersion) {
          const enriched = {
            ...queuedDuplicate,
            bankSignals,
            bankSignalFingerprint: await bankSignalFingerprint(bankSignals),
            updated: Date.now(),
          };
          await callRpc("bank_enqueue_transaction", { p_item: enriched });
        }
        continue;
      }
      const accepted = acceptBankTransaction(t, known);
      if (!accepted) continue;
      const { amount, bankId } = accepted;
      const isIncome = t.creditDebitIndicator === "Credit";
      const cp = isIncome
        ? ((t.DebtorParty as Rec)?.name || "")
        : ((t.CreditorParty as Rec)?.name || "");
      const queueItem = {
        id: await bankQueueRecordId(bankId),
        date: String(t.documentProcessDate || fmt(new Date())).slice(0, 10),
        type: isIncome ? "income" : "expense",
        amount,
        method: detectedMethod,
        source: "bank",
        counterparty: cp,
        comment: String(t.description || "").slice(0, 300),
        bankId, bankSignals, bankSignalFingerprint: await bankSignalFingerprint(bankSignals),
        bankRuleState: "pending", created: Date.now(), updated: Date.now(),
      };
      const { data: enqueued, error: enqueueError } = await callRpc("bank_enqueue_transaction", { p_item: queueItem });
      if (enqueueError) throw new Error("Не удалось безопасно сохранить банковскую операцию");
      if ((enqueued as Rec)?.added) added++;
    }
    if (deadlineStopped) break;
  }

  // Остаток: суммы как отдаёт банк, знак НЕ переворачиваем
  try {
    if (Date.now() >= deadline) throw new Error("Истёк безопасный срок синхронизации");
    const balRes = await tochkaFetch("/open-banking/v1.0/balances", {
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    const bals: Rec[] = balRes?.Data?.Balance || [];
    const total = sumBankBalances(bals);
    await kvSet("BANK_BALANCE", { amount: total, updated: new Date().toISOString() });
  } catch (_e) { /* остаток не критичен */ }

  const result = bankSyncResult(diagnostics, added);
  if (added > 0) await autoProcessBankQueue();
  if (result.ok && result.outcome !== "partial") {
    await kvSet(
      "LAST_SYNC",
      `${new Date().toISOString()} | добавлено: ${added} | результат: ${result.outcome} | обработано счетов: ${diagnostics.accounts.processed}/${diagnostics.accounts.total}`,
    );
  }
  return result;
}

export async function runTochkaSync(days = 30) {
  const attemptedAt = new Date().toISOString();
  let leaseId: string | null = null;
  try {
    leaseId = await acquireTochkaSyncLease();
    if (!leaseId) {
      return { ok: false, error: "Синхронизация уже выполняется", outcome: "busy" };
    }

    const deadline = Date.now() + TOCHKA_SYNC_DEADLINE_MS;
    await kvSet("LAST_SYNC_ATTEMPT", attemptedAt);
    try {
      await remindDeadlines();
      const result = await tochkaSync(days, deadline);
      const complete = result.ok && "outcome" in result && result.outcome !== "partial";
      await kvSet(
        "LAST_SYNC_ERROR",
        complete ? null : `${attemptedAt} | Синхронизация с Точка Банком выполнена не полностью`,
      );
      return result;
    } catch (_error) {
      // Не сохраняем исходный текст ошибки: ответ банка может содержать чувствительные данные.
      await kvSet("LAST_SYNC_ERROR", `${attemptedAt} | Синхронизация с Точка Банком не выполнена`);
      return { ok: false, error: "Синхронизация с Точка Банком не выполнена", outcome: "failed" };
    }
  } catch (_error) {
    return { ok: false, error: "Синхронизация с Точка Банком не выполнена", outcome: "failed" };
  } finally {
    if (leaseId) {
      try {
        await releaseTochkaSyncLease(leaseId);
      } catch (_error) {
        // Просроченная аренда будет безопасно перехвачена следующим запуском.
      }
    }
  }
}
