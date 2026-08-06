import {
  BANK_RULE_ENGINE_VERSION,
  DEFAULT_BANK_RULE_SETTINGS,
  aggregateBankRulePreview,
  bankRuleEvaluationToken,
  canonicalJson,
  evaluateBankRules,
  publicBankRuleEvaluation,
  safeBankRuleSettings,
  validateBankRule,
} from "./bank-rules.js";
import { accessSet, businessIdOf, isAdmin, scopeWriteError } from "./rules.js";
import { callRpc, readAll, readOne, writeRow } from "./db/repositories.ts";
import type { Rec } from "./types.ts";

const encoder = new TextEncoder();

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function bankSignalFingerprint(signals: unknown) {
  return `s1:${await sha256(canonicalJson(signals || {}))}`;
}

async function ruleChecksum(rule: unknown) {
  return `r1:${await sha256(canonicalJson(rule || {}))}`;
}

function adminError(user: Rec | null) {
  return !user || !isAdmin(user) || user.active === false ? "Только для админа" : null;
}

async function settingsRecord() {
  const current = (await readAll("bankRuleSettings"))[0];
  if (current) return safeBankRuleSettings(current);
  const initial = { ...DEFAULT_BANK_RULE_SETTINGS, settingsVersion: 1, created: Date.now(), updated: Date.now() };
  await writeRow("bankRuleSettings", initial as Rec);
  return safeBankRuleSettings(initial);
}

async function bankData() {
  const entities = [
    "bankRules", "bankRuleVersions", "bankRuleApplications", "bankRuleRuns", "bankRuleSettings", "bankRuleSettingVersions",
    "businesses", "memberships", "businessOwners", "players", "companies", "contacts", "deals",
    "events", "eventRegistrations", "eventBudgetLines", "financeRelations", "eventFinanceAllocations",
  ];
  const rows = await Promise.all(entities.map(readAll));
  return Object.fromEntries(entities.map((entity, index) => [entity, rows[index]])) as Record<string, Rec[]>;
}

function sameBusiness(item: Rec | undefined, businessId: string) {
  return !!item && businessIdOf(item) === businessId && item.businessId === businessId && item.unit === businessId;
}

function validateActionTargets(user: Rec | null, actions: Rec, data: Record<string, Rec[]>, actor = "admin", requireClassification = true) {
  const businessId = String(actions.businessId || "").trim();
  if (!businessId) return "Не указан бизнес";
  const business = data.businesses.find((item) => item.id === businessId);
  if (!business || business.active === false) return "Бизнес не найден или находится в архиве";
  if (actor !== "cron") {
    const deny = scopeWriteError(accessSet(data.memberships || [], user?.id), { businessId, unit: businessId }, data.businesses);
    if (deny) return deny;
  }
  if ((requireClassification && !String(actions.category || "").trim()) || String(actions.category || "").length > 120) return "Не указана категория";
  if (actions.owner && !(data.businessOwners || []).some((owner) =>
    sameBusiness(owner, businessId) && owner.ownerId === actions.owner && owner.active !== false
  )) return "Владелец не относится к этому бизнесу";

  const links = (actions.links || {}) as Rec;
  const entities: Array<[string, string]> = [
    ["playerId", "players"], ["companyId", "companies"], ["contactId", "contacts"], ["dealId", "deals"],
  ];
  for (const [field, entity] of entities) {
    if (links[field] && !sameBusiness(data[entity].find((item) => item.id === links[field]), businessId)) {
      return "Связанная запись не относится к этому бизнесу";
    }
  }
  const contact = data.contacts.find((item) => item.id === links.contactId);
  const deal = data.deals.find((item) => item.id === links.dealId);
  if (contact && links.companyId && contact.companyId !== links.companyId) return "Контакт не относится к выбранной компании";
  if (deal && links.companyId && deal.companyId && deal.companyId !== links.companyId) return "Сделка не относится к выбранной компании";
  if (deal && links.contactId && deal.contactId && deal.contactId !== links.contactId) return "Сделка не относится к выбранному контакту";

  const eventLink = links.event as Rec | undefined;
  if (eventLink?.eventId) {
    if (!Array.isArray(business.modules) || !business.modules.includes("events")) return "Модуль «События» выключен";
    const event = data.events.find((item) => item.id === eventLink.eventId);
    if (!sameBusiness(event, businessId)) return "Событие не относится к этому бизнесу";
    if (event?.settlementStatus === "closed") return "Расчёт события уже закрыт";
    if (eventLink.registrationId) {
      const registration = data.eventRegistrations.find((item) => item.id === eventLink.registrationId);
      if (!sameBusiness(registration, businessId) || registration?.eventId !== eventLink.eventId) return "Регистрация не относится к событию";
      const expectedParticipant = links.playerId || links.companyId || links.contactId;
      if (expectedParticipant && registration?.participantId !== expectedParticipant) return "Регистрация относится к другому участнику";
    }
    if (eventLink.budgetLineId) {
      const budgetLine = data.eventBudgetLines.find((item) => item.id === eventLink.budgetLineId);
      if (!sameBusiness(budgetLine, businessId) || budgetLine?.eventId !== eventLink.eventId) return "Строка бюджета не относится к событию";
    }
  }
  return null;
}

export async function listBankRules(user: Rec) {
  const deny = adminError(user);
  if (deny) return { ok: false, error: deny };
  const [rules, versions] = await Promise.all([readAll("bankRules"), readAll("bankRuleVersions")]);
  return { ok: true, rules, versions };
}

export async function saveBankRule(user: Rec, source: Rec, expectedVersion: unknown) {
  const deny = adminError(user);
  if (deny) return { ok: false, error: deny };
  const validation = validateBankRule(source);
  if (!validation.ok) return { ok: false, error: validation.errors[0], errors: validation.errors };
  const data = await bankData();
  const id = String(validation.rule.id || `bank-rule:${crypto.randomUUID()}`);
  const current = data.bankRules.find((item) => item.id === id);
  const targetDeny = validation.rule.actions?.businessId
    ? validateActionTargets(user, validation.rule.actions, data, "admin", validation.rule.decision === "auto") : null;
  if (targetDeny) return { ok: false, error: targetDeny };
  const now = Date.now();
  const rule = {
    ...validation.rule,
    id,
    enabled: validation.rule.enabled !== false,
    createdBy: current?.createdBy || user.id,
    updatedBy: user.id,
    created: current?.created || now,
    updated: now,
  } as Rec;
  const checksum = await ruleChecksum({ ...rule, version: undefined, checksum: undefined, updated: undefined });
  const { data: result, error } = await callRpc("bank_rule_save", {
    p_rule: { ...rule, checksum },
    p_expected_version: Math.max(0, Math.floor(Number(expectedVersion || 0))),
    p_actor: String(user.id),
  });
  if (error) return { ok: false, error: "Правило уже изменено или содержит недопустимые данные" };
  return result as Rec;
}

export async function enableBankRule(user: Rec, id: unknown, enabled: unknown, expectedVersion: unknown) {
  const deny = adminError(user);
  if (deny) return { ok: false, error: deny };
  const current = await readOne("bankRules", String(id || ""));
  if (!current) return { ok: false, error: "Правило не найдено" };
  if (current.deleted === true && enabled === true) return { ok: false, error: "Архивное правило нельзя включить" };
  return await saveBankRule(user, { ...current, enabled: enabled === true }, expectedVersion);
}

export async function deleteBankRule(user: Rec, id: unknown, expectedVersion: unknown) {
  const deny = adminError(user);
  if (deny) return { ok: false, error: deny };
  const current = await readOne("bankRules", String(id || ""));
  if (!current) return { ok: false, error: "Правило не найдено" };
  return await saveBankRule(user, { ...current, enabled: false, deleted: true, deletedAt: Date.now() }, expectedVersion);
}

export async function getBankRuleSettings(user: Rec) {
  const deny = adminError(user);
  if (deny) return { ok: false, error: deny };
  return { ok: true, settings: await settingsRecord() };
}

export async function updateBankRuleSettings(user: Rec, source: Rec, expectedVersion: unknown) {
  const deny = adminError(user);
  if (deny) return { ok: false, error: deny };
  const current = await settingsRecord();
  const settings = safeBankRuleSettings({ ...source, id: current.id, created: current.created });
  if (!settings.allowedDirections.length && settings.autoEnabled) {
    return { ok: false, error: "Для автопроведения выберите хотя бы одно направление" };
  }
  if (settings.autoEnabled && (!settings.maxTransactionsPerDay || !settings.maxTotalAmountMinorPerDay
    || (!settings.maxAmountMinor.income && !settings.maxAmountMinor.expense))) {
    return { ok: false, error: "Перед включением автопроведения задайте безопасные лимиты" };
  }
  const { data, error } = await callRpc("bank_rule_settings_save", {
    p_settings: { ...settings, updatedBy: user.id, updated: Date.now() },
    p_expected_version: Math.max(1, Math.floor(Number(expectedVersion || 1))),
    p_actor: String(user.id),
  });
  if (error) return { ok: false, error: "Настройки уже изменены другим запросом" };
  return data as Rec;
}

export async function previewBankRuleTransaction(user: Rec, transactionId: unknown, draft?: Rec) {
  const deny = adminError(user);
  if (deny) return { ok: false, error: deny };
  const transaction = await readOne("bankTransactions", String(transactionId || ""));
  if (!transaction) return { ok: false, error: "Банковская операция не найдена" };
  let rules = await readAll("bankRules");
  if (draft) {
    const validation = validateBankRule(draft);
    if (!validation.ok) return { ok: false, error: validation.errors[0], errors: validation.errors };
    const id = String(validation.rule.id || "draft");
    rules = [{ ...validation.rule, id, version: validation.rule.version || 0 }, ...rules.filter((rule) => rule.id !== id)];
  }
  const result = evaluateBankRules(transaction.bankSignals || {}, rules, await settingsRecord());
  return { ok: true, evaluation: publicBankRuleEvaluation(result as Rec), evaluationToken: bankRuleEvaluationToken(transaction, result) };
}

export async function dryRunBankRules(user: Rec, draft?: Rec) {
  const deny = adminError(user);
  if (deny) return { ok: false, error: deny };
  let rules = await readAll("bankRules");
  if (draft) {
    const validation = validateBankRule(draft);
    if (!validation.ok) return { ok: false, error: validation.errors[0], errors: validation.errors };
    const id = String(validation.rule.id || "draft");
    rules = [{ ...validation.rule, id, version: validation.rule.version || 0 }, ...rules.filter((rule) => rule.id !== id)];
  }
  const queue = await readAll("bankTransactions");
  const summary = aggregateBankRulePreview(queue, rules, await settingsRecord());
  const run: Rec = {
    id: `bank-rule-run:${crypto.randomUUID()}`, kind: "dry-run", summary,
    engineVersion: BANK_RULE_ENGINE_VERSION, actor: String(user.id), created: Date.now(),
  };
  const { error } = await callRpc("bank_rule_append_run", { p_run: run });
  if (error) return { ok: false, error: "Не удалось сохранить безопасный итог проверки" };
  return { ok: true, summary };
}

async function currentLimitContext(ruleId: string, runId = "") {
  const applications = await readAll("bankRuleApplications");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
  const appliedToday = applications.filter((item) => item.state === "applied" && item.decision === "auto" && item.day === today);
  return {
    transactionsThisRun: runId ? appliedToday.filter((item) => item.runId === runId).length : 0,
    transactionsToday: appliedToday.length,
    totalAmountMinorToday: appliedToday.reduce((sum, item) => sum + Number(item.amountMinor || 0), 0),
    ruleTransactionsToday: appliedToday.filter((item) => item.appliedRuleId === ruleId).length,
  };
}

async function existingApplicationResult(idempotencyKey: string, sourceQueueId: string, operation: string) {
  if (!idempotencyKey) return null;
  const application = (await readAll("bankRuleApplications")).find((item) => item.idempotencyKey === idempotencyKey);
  if (!application) return null;
  if (application.sourceQueueId !== sourceQueueId || application.operation !== operation) {
    return { ok: false, error: "Ключ повторяемости использован для другого действия" };
  }
  const item = application.financeId ? await readOne("finance", String(application.financeId)) : null;
  return { ok: true, item, application, alreadyProcessed: true, applied: application.state === "applied" };
}

async function applyEvaluated(
  user: Rec | null,
  transaction: Rec,
  result: Rec,
  idempotencyKey: string,
  expectedFingerprint: string,
  actor = "admin",
  runId = "",
  decision = "suggest",
) {
  const data = await bankData();
  const targetDeny = validateActionTargets(user, result.actions || {}, data, actor);
  if (targetDeny) return { ok: false, error: targetDeny };
  const fingerprint = await bankSignalFingerprint(transaction.bankSignals || {});
  if (expectedFingerprint && expectedFingerprint !== fingerprint) return { ok: false, error: "Предложение устарело" };
  const actions = result.actions || {};
  const now = Date.now();
  const applicationId = `bank-application:${await sha256(idempotencyKey)}`;
  const financeId = `bank:${transaction.id}`;
  const links = actions.links || {};
  const relations = await Promise.all(["playerId", "companyId", "contactId", "dealId"].filter((field) => links[field]).map(async (field) => ({
    id: `finance-relation:${await sha256(`${idempotencyKey}:${field}`)}`,
    businessId: actions.businessId, unit: actions.businessId, financeId,
    relationType: field.replace(/Id$/, ""), relationId: links[field],
    applicationId, idempotencyKey: `${idempotencyKey}:${field}`,
    created: now,
  })));
  const amountMinor = Number(transaction.bankSignals?.amountMinor ?? Math.round(Number(transaction.amount || 0) * 100));
  const event = links.event ? {
    businessId: actions.businessId, unit: actions.businessId,
    eventId: links.event.eventId, financeId,
    registrationId: links.event.registrationId || undefined,
    budgetLineId: links.event.budgetLineId || undefined,
    purpose: links.event.purpose,
    amount: Number(links.event.amountMinor || amountMinor) / 100,
    idempotencyKey: `${idempotencyKey}:event`, createdBy: actor === "cron" ? "cron" : user?.id,
    created: now, updated: now,
  } : null;
  const finance = {
    id: financeId, businessId: actions.businessId, unit: actions.businessId,
    date: transaction.date, type: transaction.type, amount: Number(amountMinor) / 100,
    method: actions.methodOverride || transaction.method || "account", source: "bank",
    category: actions.category,
    counterparty: actions.counterpartyOverride || transaction.counterparty || "",
    comment: actions.comment ? `${transaction.comment || ""}${transaction.comment ? " · " : ""}${actions.comment}` : transaction.comment || "",
    owner: actions.owner || undefined, tags: actions.tags || [],
    bankId: transaction.bankId, bankQueueId: transaction.id,
    bankSignals: transaction.bankSignals, bankSignalFingerprint: fingerprint,
    bankOriginal: {
      method: transaction.method || "account",
      counterparty: transaction.counterparty || "",
      comment: transaction.comment || "",
    },
    appliedRuleId: result.appliedRuleId,
    appliedRuleVersion: result.appliedRuleVersion, applicationId,
    created: transaction.created || now, updated: now,
  };
  const application = {
    id: applicationId, idempotencyKey, runId: runId || undefined,
    sourceQueueId: transaction.id, operation: "apply",
    appliedRuleId: result.appliedRuleId, appliedRuleVersion: result.appliedRuleVersion,
    settingsVersion: (await settingsRecord()).settingsVersion,
    engineVersion: BANK_RULE_ENGINE_VERSION, decision: actor === "cron" ? "auto" : decision,
    requestedDecision: result.requestedDecision || decision,
    state: "applied", confidence: result.confidence,
    explanation: {
      amountOnly: result.amountOnly, conflict: result.conflict,
      missingSignals: result.missingSignals?.length || 0,
      strongEvidenceCount: result.strongEvidenceCount || 0,
      contextEvidenceCount: result.contextEvidenceCount || 0,
    },
    actionSnapshot: actions, financeId, queueFingerprint: fingerprint, amountMinor,
    actor: actor === "cron" ? "cron" : String(user?.id || ""),
    day: new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date()),
    created: now,
  };
  const payload = {
    mode: "apply", queueId: transaction.id, bankId: transaction.bankId,
    expectedUpdated: transaction.updated, expectedFingerprint: fingerprint,
    idempotencyKey, requestChecksum: await ruleChecksum({
      mode: "apply", queueId: transaction.id, bankId: transaction.bankId,
      expectedUpdated: transaction.updated, expectedFingerprint: fingerprint,
      actor, runId, decision, actions, appliedRuleId: result.appliedRuleId,
      appliedRuleVersion: result.appliedRuleVersion,
    }),
    auto: actor === "cron", runId, finance, relations, event, application,
  };
  const { data: applied, error } = await callRpc("apply_bank_rule_transaction", { p_payload: payload });
  if (error) return { ok: false, error: "Не удалось безопасно применить правило" };
  return applied as Rec;
}

export async function manualProcessBankTransaction(user: Rec, id: unknown, businessId: unknown, category: unknown) {
  const deny = adminError(user);
  if (deny) return { ok: false, error: deny };
  const queueId = String(id || "").trim();
  const targetBusinessId = String(businessId || "").trim();
  const targetCategory = String(category || "").trim();
  if (!queueId) return { ok: false, error: "Не указана банковская операция" };
  if (!targetBusinessId) return { ok: false, error: "Не указан бизнес" };
  if (!targetCategory || targetCategory.length > 120) return { ok: false, error: "Не указана категория" };
  const transaction = await readOne("bankTransactions", queueId);
  if (!transaction) {
    const application = (await readAll("bankRuleApplications")).find((item) =>
      item.sourceQueueId === queueId && item.operation === "apply" && item.decision === "manual"
    );
    if (application?.financeId) {
      const applied = await readOne("finance", String(application.financeId));
      if (applied) return { ok: true, item: applied, application, alreadyProcessed: true };
    }
    const item = await readOne("finance", `bank:${queueId}`);
    return item ? { ok: true, item, alreadyProcessed: true } : { ok: false, error: "Банковская операция не найдена" };
  }
  const fingerprint = await bankSignalFingerprint(transaction.bankSignals || {});
  const result = {
    actions: { businessId: targetBusinessId, category: targetCategory },
    appliedRuleId: undefined, appliedRuleVersion: undefined,
    confidence: 1, amountOnly: false, conflict: false, missingSignals: [],
  } as Rec;
  return await applyEvaluated(
    user, transaction, result, `manual:${queueId}:${Number(transaction.updated || 0)}:${fingerprint.slice(0, 20)}`,
    fingerprint, "admin", "", "manual",
  );
}

export async function applyBankRuleSuggestion(
  user: Rec,
  transactionId: unknown,
  expectedEvaluationToken: unknown,
  idempotencyKey: unknown,
) {
  const deny = adminError(user);
  if (deny) return { ok: false, error: deny };
  const key = String(idempotencyKey || "").trim();
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(key)) return { ok: false, error: "Некорректный ключ повторяемости" };
  const existing = await existingApplicationResult(key, String(transactionId || ""), "apply");
  if (existing) return existing;
  const transaction = await readOne("bankTransactions", String(transactionId || ""));
  if (!transaction) return { ok: false, error: "Банковская операция не найдена" };
  if (transaction.bankRuleState && transaction.bankRuleState !== "pending") return { ok: false, error: "Сначала верните операцию к проверке" };
  const rules = await readAll("bankRules");
  const settings = await settingsRecord();
  const base = evaluateBankRules(transaction.bankSignals || {}, rules, settings) as Rec;
  const result = evaluateBankRules(
    transaction.bankSignals || {}, rules, settings,
    await currentLimitContext(String(base.appliedRuleId || "")),
  ) as Rec;
  if (!result.appliedRuleId || result.conflict || result.requestedDecision === "manual" || result.requestedDecision === "ignore") {
    return { ok: false, error: result.conflict ? "Правила конфликтуют" : "Эта операция требует ручной обработки" };
  }
  if (!expectedEvaluationToken || expectedEvaluationToken !== bankRuleEvaluationToken(transaction, result)) {
    return { ok: false, error: "Предложение устарело" };
  }
  return await applyEvaluated(user, transaction, result, key, await bankSignalFingerprint(transaction.bankSignals || {}));
}

async function queueStateAction(user: Rec | null, transactionId: unknown, state: string, reason: string, idempotencyKey: unknown, actor = "admin") {
  const deny = actor === "cron" ? null : adminError(user);
  if (deny) return { ok: false, error: deny };
  const key = String(idempotencyKey || "").trim();
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(key)) return { ok: false, error: "Некорректный ключ повторяемости" };
  const operation = `queue:${state}:${reason}`;
  const existing = await existingApplicationResult(key, String(transactionId || ""), operation);
  if (existing) return existing;
  const transaction = await readOne("bankTransactions", String(transactionId || ""));
  if (!transaction) return { ok: false, error: "Банковская операция не найдена" };
  const fingerprint = await bankSignalFingerprint(transaction.bankSignals || {});
  const applicationId = `bank-application:${await sha256(key)}`;
  const payload = {
    mode: "queue_state", queueId: transaction.id, bankId: transaction.bankId,
    expectedUpdated: transaction.updated, expectedFingerprint: fingerprint,
    idempotencyKey: key, requestChecksum: await ruleChecksum({ state, reason, queueId: transaction.id }),
    queueState: state,
    application: {
      id: applicationId, idempotencyKey: key,
      sourceQueueId: transaction.id, operation,
      engineVersion: BANK_RULE_ENGINE_VERSION, decision: state, state: reason,
      queueFingerprint: fingerprint, actor: actor === "cron" ? "cron" : String(user?.id || ""), created: Date.now(),
    },
  };
  const { data, error } = await callRpc("apply_bank_rule_transaction", { p_payload: payload });
  if (error) return { ok: false, error: "Не удалось безопасно изменить состояние операции" };
  return data as Rec;
}

export const rejectBankRuleSuggestion = (user: Rec, transactionId: unknown, idempotencyKey: unknown) =>
  queueStateAction(user, transactionId, "pending", "rejected", idempotencyKey);

export const ignoreBankTransaction = (user: Rec, transactionId: unknown, idempotencyKey: unknown) =>
  queueStateAction(user, transactionId, "ignored", "ignored", idempotencyKey);

export const requireManualBankTransaction = (user: Rec, transactionId: unknown, idempotencyKey: unknown) =>
  queueStateAction(user, transactionId, "manual", "manual", idempotencyKey);

export async function reevaluateBankTransaction(user: Rec, transactionId: unknown, idempotencyKey: unknown) {
  const changed = await queueStateAction(user, transactionId, "pending", "reevaluated", idempotencyKey);
  if (!changed.ok) return changed;
  return await previewBankRuleTransaction(user, transactionId);
}

function safeApplication(item: Rec) {
  const {
    amountMinor: _amount, queueFingerprint: _fingerprint, actionSnapshot: _actions,
    before: _before, after: _after, financeFingerprint: _financeFingerprint, ...safe
  } = item;
  const classification = (value: Rec | undefined) => value ? {
    category: value.category, method: value.method, owner: value.owner,
  } : undefined;
  return { ...safe, ...(item.before ? { before: classification(item.before as Rec) } : {}), ...(item.after ? { after: classification(item.after as Rec) } : {}) };
}

export async function bankRuleJournal(user: Rec, limit: unknown = 100) {
  const deny = adminError(user);
  if (deny) return { ok: false, error: deny };
  const count = Math.min(200, Math.max(1, Math.floor(Number(limit || 100))));
  const applications = (await readAll("bankRuleApplications"))
    .sort((a, b) => Number(b.created || 0) - Number(a.created || 0)).slice(0, count).map(safeApplication);
  return { ok: true, applications };
}

export async function correctBankRuleApplication(user: Rec, applicationId: unknown, patch: Rec, idempotencyKey: unknown) {
  const deny = adminError(user);
  if (deny) return { ok: false, error: deny };
  const allowed = ["category", "method", "owner", "comment", "counterparty"];
  if (Object.keys(patch || {}).some((key) => !allowed.includes(key))) return { ok: false, error: "Можно исправить только классификацию" };
  if (Object.values(patch || {}).some((value) => typeof value !== "string")) return { ok: false, error: "Поля исправления должны быть строками" };
  if (patch.category !== undefined && (!String(patch.category).trim() || String(patch.category).length > 120)) return { ok: false, error: "Некорректная категория" };
  if (patch.method !== undefined && !["account", "card", "sbp", "cash", "other"].includes(String(patch.method))) return { ok: false, error: "Некорректный способ оплаты" };
  if (patch.owner !== undefined && String(patch.owner).length > 128) return { ok: false, error: "Некорректный владелец" };
  if (patch.comment !== undefined && String(patch.comment).length > 300) return { ok: false, error: "Комментарий слишком длинный" };
  if (patch.counterparty !== undefined && String(patch.counterparty).length > 160) return { ok: false, error: "Контрагент слишком длинный" };
  const key = String(idempotencyKey || "").trim();
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(key)) return { ok: false, error: "Некорректный ключ повторяемости" };
  const { data, error } = await callRpc("correct_bank_rule_transaction", {
    p_application_id: String(applicationId || ""), p_patch: patch || {},
    p_idempotency_key: key, p_actor: String(user.id),
  });
  if (error) return { ok: false, error: "Исправление невозможно или операция уже изменилась" };
  return data as Rec;
}

export async function reverseBankRuleApplication(user: Rec, applicationId: unknown, idempotencyKey: unknown) {
  const deny = adminError(user);
  if (deny) return { ok: false, error: deny };
  const key = String(idempotencyKey || "").trim();
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(key)) return { ok: false, error: "Некорректный ключ повторяемости" };
  const { data, error } = await callRpc("reverse_bank_rule_transaction", {
    p_application_id: String(applicationId || ""), p_idempotency_key: key, p_actor: String(user.id),
  });
  if (error) return { ok: false, error: "Безопасная отмена невозможна: операция или её связи уже изменились" };
  return data as Rec;
}

export async function autoProcessBankQueue() {
  const settings = await settingsRecord();
  const [queue, rules] = await Promise.all([readAll("bankTransactions"), readAll("bankRules")]);
  const runId = `bank-auto-run:${crypto.randomUUID()}`;
  let applied = 0;
  let ignored = 0;
  let manual = 0;
  const candidates = queue.filter((transaction) => transaction.bankRuleState !== "ignored" && transaction.bankRuleState !== "manual")
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || String(a.id).localeCompare(String(b.id)))
    .slice(0, 5000);
  for (const transaction of candidates) {
    const base = evaluateBankRules(transaction.bankSignals || {}, rules, settings) as Rec;
    const context = await currentLimitContext(String(base.appliedRuleId || ""), runId);
    const result = evaluateBankRules(transaction.bankSignals || {}, rules, settings, context) as Rec;
    if (!result.conflict && result.state === "matched" && ["ignore", "manual"].includes(String(result.requestedDecision || ""))) {
      const state = String(result.requestedDecision);
      const outcome = await queueStateAction(
        null, transaction.id, state, state,
        `auto-state:${await sha256(`${runId}:${transaction.id}:${state}`)}`, "cron",
      );
      if (outcome.ok) {
        if (state === "ignore") ignored++;
        else manual++;
      }
      continue;
    }
    if (!result.autoEligible || applied >= settings.maxTransactionsPerRun) continue;
    const outcome = await applyEvaluated(
      null, transaction, result, `auto:${runId}:${transaction.id}`,
      await bankSignalFingerprint(transaction.bankSignals || {}), "cron", runId,
    );
    if (outcome.ok && outcome.applied === true) applied++;
  }
  const summary = { total: queue.length, applied, ignored, manual, disabled: !settings.autoEnabled };
  await callRpc("bank_rule_append_run", {
    p_run: { id: runId, kind: "auto", summary, engineVersion: BANK_RULE_ENGINE_VERSION, actor: "cron", created: Date.now() },
  });
  return { ok: true, ...summary };
}
