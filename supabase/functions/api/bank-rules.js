// Общие чистые правила банковского разбора. Файл зеркалируется в
// supabase/functions/api/bank-rules.js и не должен зависеть от DOM/Deno.

export const BANK_RULE_ENGINE_VERSION = 1;
export const BANK_SIGNAL_SCHEMA_VERSION = 1;
export const BANK_RULE_DECISIONS = ['suggest', 'auto', 'ignore', 'manual'];
export const BANK_RULE_MAX_CONDITIONS = 24;
export const BANK_RULE_MAX_REGEX = 120;

export const DEFAULT_BANK_RULE_SETTINGS = Object.freeze({
  id: 'bank-rule-settings',
  settingsVersion: 1,
  autoEnabled: false,
  allowedDirections: ['income', 'expense'],
  maxAmountMinor: { income: 1000000, expense: 1000000 },
  maxTransactionsPerRun: 10,
  maxTransactionsPerDay: 20,
  maxTotalAmountMinorPerDay: 5000000,
});

const FIELD_OPS = Object.freeze({
  direction: ['exact'],
  amountMinor: ['exact', 'range'],
  currency: ['exact'],
  detectedMethod: ['exact'],
  transactionTypeCode: ['exact', 'contains'],
  schemeName: ['exact'],
  sourceAccountKey: ['exact'],
  'sender.nameNormalized': ['exact', 'contains'],
  'recipient.nameNormalized': ['exact', 'contains'],
  'sender.phoneE164': ['exact'],
  'recipient.phoneE164': ['exact'],
  'sender.inn': ['exact'],
  'recipient.inn': ['exact'],
  'sender.accountKey': ['exact'],
  'recipient.accountKey': ['exact'],
  descriptionNormalized: ['exact', 'contains', 'regex'],
  bankIdStrength: ['exact'],
});

const STRONG_FIELDS = new Set([
  'sourceAccountKey', 'sender.phoneE164', 'recipient.phoneE164',
  'sender.inn', 'recipient.inn', 'sender.accountKey', 'recipient.accountKey',
]);
const CONTEXT_FIELDS = new Set([
  'sender.nameNormalized', 'recipient.nameNormalized', 'descriptionNormalized',
]);
const WEAK_FIELDS = new Set(['direction', 'amountMinor', 'detectedMethod']);

const text = (value, max = 160) => String(value ?? '').trim().slice(0, max);

export function normalizeBankText(value, max = 300) {
  return text(value, max).normalize('NFKC').toLocaleLowerCase('ru-RU')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

export function amountToMinor(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    value = value.toFixed(2);
  }
  const match = String(value ?? '').trim().replace(',', '.').match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const minor = BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0'));
  const signed = match[1] ? -minor : minor;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) return null;
  return Number(signed);
}

export function normalizePhone(value) {
  const source = text(value, 40);
  if (!source || /[*xх•]/i.test(source)) return '';
  let digits = source.replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('9')) digits = `7${digits}`;
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  if (digits.length < 10 || digits.length > 15) return '';
  return `+${digits}`;
}

export function normalizeInn(value) {
  const source = text(value, 24);
  if (!source || /[*xх•]/i.test(source)) return '';
  const digits = source.replace(/\D/g, '');
  return digits.length === 10 || digits.length === 12 ? digits : '';
}

function first(source, paths) {
  for (const path of paths) {
    let value = source;
    for (const part of path.split('.')) value = value?.[part];
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return '';
}

async function safeAccountKey(value, accountKey) {
  const raw = text(value, 180);
  if (!raw || /[*xх•]/i.test(raw) || typeof accountKey !== 'function') return '';
  return text(await accountKey(raw), 96);
}

async function normalizedParty(party, account, accountKey) {
  const name = first(party, ['name', 'partyName', 'legalName']);
  const phone = first(party, ['phone', 'phoneNumber', 'mobilePhone']) ||
    (String(account?.schemeName || '') === 'RU.CBR.CellphoneNumber'
      ? first(account, ['identification', 'accountId', 'id']) : '');
  const normalizedAccountKey = await safeAccountKey(first(account, ['identification', 'accountId', 'id']), accountKey);
  return {
    ...(name ? { nameNormalized: normalizeBankText(name, 160) } : {}),
    ...(normalizePhone(phone) ? { phoneE164: normalizePhone(phone) } : {}),
    ...(normalizeInn(first(party, ['inn', 'taxId', 'identification.inn']))
      ? { inn: normalizeInn(first(party, ['inn', 'taxId', 'identification.inn'])) } : {}),
    ...(normalizedAccountKey ? { accountKey: normalizedAccountKey } : {}),
  };
}

export async function normalizeBankSignals(transaction, options = {}) {
  const direction = transaction?.creditDebitIndicator === 'Credit' ? 'income'
    : transaction?.creditDebitIndicator === 'Debit' ? 'expense' : '';
  const senderParty = direction === 'income' ? transaction?.DebtorParty : transaction?.DebtorParty;
  const recipientParty = direction === 'income' ? transaction?.CreditorParty : transaction?.CreditorParty;
  const senderAccount = transaction?.DebtorAccount || {};
  const recipientAccount = transaction?.CreditorAccount || {};
  const counterpartAccount = direction === 'income' ? senderAccount : recipientAccount;
  const schemeName = text(counterpartAccount?.schemeName, 80);
  const amountMinor = amountToMinor(transaction?.Amount?.amount);
  const sourceAccountKey = await safeAccountKey(options.sourceAccountId, options.accountKey);
  const sender = await normalizedParty(senderParty || {}, senderAccount, options.accountKey);
  const recipient = await normalizedParty(recipientParty || {}, recipientAccount, options.accountKey);
  const currency = text(transaction?.Amount?.currency || transaction?.currency, 8).toUpperCase();
  const transactionTypeCode = text(transaction?.transactionTypeCode, 120);
  const descriptionNormalized = normalizeBankText(transaction?.description, 300);
  const detectedMethod = text(options.detectedMethod, 24);
  const strongBankId = !!(transaction?.transactionId || transaction?.paymentId);
  return {
    schemaVersion: BANK_SIGNAL_SCHEMA_VERSION,
    ...(direction ? { direction } : {}),
    ...(amountMinor !== null ? { amountMinor: Math.abs(amountMinor) } : {}),
    ...(currency ? { currency } : {}),
    ...(detectedMethod ? { detectedMethod } : {}),
    ...(transactionTypeCode ? { transactionTypeCode } : {}),
    ...(schemeName ? { schemeName } : {}),
    ...(sourceAccountKey ? { sourceAccountKey } : {}),
    ...(Object.keys(sender).length ? { sender } : {}),
    ...(Object.keys(recipient).length ? { recipient } : {}),
    ...(descriptionNormalized ? { descriptionNormalized } : {}),
    bankIdStrength: strongBankId ? 'strong' : 'fallback',
  };
}

export function isSafeBankSignals(signals) {
  if (!signals || typeof signals !== 'object' || Array.isArray(signals)) return false;
  const keys = Object.keys(signals);
  if (!keys.length) return true;
  const allowed = new Set([
    'schemaVersion', 'direction', 'amountMinor', 'currency', 'detectedMethod', 'transactionTypeCode',
    'schemeName', 'sourceAccountKey', 'sender', 'recipient', 'descriptionNormalized', 'bankIdStrength',
  ]);
  if (keys.some((key) => !allowed.has(key)) || signals.schemaVersion !== 1) return false;
  if (signals.direction !== undefined && !['income', 'expense'].includes(signals.direction)) return false;
  if (signals.amountMinor !== undefined && (!Number.isSafeInteger(signals.amountMinor) || signals.amountMinor < 0)) return false;
  const stringLimits = { currency: 8, detectedMethod: 24, transactionTypeCode: 120, schemeName: 80, descriptionNormalized: 300 };
  if (Object.entries(stringLimits).some(([key, limit]) => signals[key] !== undefined
    && (typeof signals[key] !== 'string' || signals[key].length > limit))) return false;
  if (signals.bankIdStrength !== undefined && !['strong', 'fallback'].includes(signals.bankIdStrength)) return false;
  const safeKey = (value) => value === undefined || (typeof value === 'string' && /^h1:[a-f0-9]{64}$/.test(value));
  if (!safeKey(signals.sourceAccountKey)) return false;
  for (const field of ['sender', 'recipient']) {
    const party = signals[field];
    if (party === undefined) continue;
    if (!party || typeof party !== 'object' || Array.isArray(party)
      || Object.keys(party).some((key) => !['nameNormalized', 'phoneE164', 'inn', 'accountKey'].includes(key))) return false;
    if (party.nameNormalized !== undefined && (typeof party.nameNormalized !== 'string' || party.nameNormalized.length > 160)) return false;
    if (party.phoneE164 !== undefined && (typeof party.phoneE164 !== 'string' || !/^\+[0-9]{10,15}$/.test(party.phoneE164))) return false;
    if (party.inn !== undefined && (typeof party.inn !== 'string' || !/^(?:[0-9]{10}|[0-9]{12})$/.test(party.inn))) return false;
    if (!safeKey(party.accountKey)) return false;
  }
  return true;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function valueAt(source, path) {
  return path.split('.').reduce((value, part) => value?.[part], source);
}

function regexError(pattern) {
  const source = String(pattern ?? '');
  if (!source || source.length > BANK_RULE_MAX_REGEX) return 'Регулярное выражение слишком длинное';
  if (/\(\?/.test(source) || /\\[1-9]/.test(source)) return 'Lookaround и обратные ссылки запрещены';
  if (/[(){}|]/.test(source) || /[*+?]\s*[*+?]/.test(source)) return 'Разрешён только безопасный линейный шаблон';
  try { new RegExp(source, 'iu'); } catch (_error) { return 'Некорректное регулярное выражение'; }
  return null;
}

function validateCondition(condition, errors) {
  if (!condition || typeof condition !== 'object') { errors.push('Некорректное условие'); return; }
  const field = String(condition.field || '');
  const op = String(condition.op || '');
  if (!FIELD_OPS[field]) errors.push(`Поле ${field || 'без названия'} не разрешено`);
  else if (!FIELD_OPS[field].includes(op)) errors.push(`Операция ${op || 'без названия'} не разрешена для ${field}`);
  if (op === 'range') {
    if (!Number.isSafeInteger(condition.value) || !Number.isSafeInteger(condition.valueTo)
      || condition.value < 0 || condition.valueTo < condition.value) errors.push('Некорректный диапазон суммы');
  } else if (field === 'amountMinor') {
    if (!Number.isSafeInteger(condition.value) || condition.value < 0) errors.push('Сумма должна быть целым числом копеек');
  } else if (typeof condition.value !== 'string' || !condition.value || condition.value.length > 300) {
    errors.push('Некорректное значение условия');
  }
  if (op === 'regex') {
    const deny = regexError(condition.value);
    if (deny) errors.push(deny);
  }
}

function conditionsOf(rule) {
  const conditions = rule?.conditions || {};
  return ['all', 'any', 'none'].flatMap((key) => Array.isArray(conditions[key]) ? conditions[key] : []);
}

export function validateBankRule(source) {
  const errors = [];
  const rule = structuredClone(source || {});
  const allowedRuleKeys = new Set([
    'id', 'name', 'enabled', 'priority', 'order', 'decision', 'stopOnMatch', 'conditions', 'actions', 'autoLimits',
    'version', 'checksum', 'createdBy', 'updatedBy', 'created', 'updated', 'deleted', 'deletedAt', 'ruleId',
  ]);
  Object.keys(rule).forEach((key) => { if (!allowedRuleKeys.has(key)) errors.push(`Поле правила ${key} не разрешено`); });
  if (typeof rule.name !== 'string' || !text(rule.name, 120) || rule.name.length > 120) errors.push('Не указано название правила');
  if (!BANK_RULE_DECISIONS.includes(rule.decision)) errors.push('Неизвестное решение правила');
  if (rule.deleted === true && rule.enabled !== false) errors.push('Архивное правило нельзя включить');
  if (!Number.isInteger(rule.priority) || rule.priority < -1000 || rule.priority > 1000) errors.push('Приоритет должен быть от -1000 до 1000');
  if (!Number.isInteger(rule.order) || rule.order < 0 || rule.order > 100000) errors.push('Некорректный порядок');
  const list = conditionsOf(rule);
  if (!rule.conditions || typeof rule.conditions !== 'object' || Array.isArray(rule.conditions)
    || Object.keys(rule.conditions).some((key) => !['all', 'any', 'none'].includes(key))
    || ['all', 'any', 'none'].some((key) => rule.conditions[key] !== undefined && !Array.isArray(rule.conditions[key]))) {
    errors.push('Некорректная структура условий');
  }
  list.forEach((condition) => {
    if (condition && typeof condition === 'object'
      && Object.keys(condition).some((key) => !['field', 'op', 'value', 'valueTo'].includes(key))) {
      errors.push('Условие содержит неизвестное поле');
    }
  });
  if (!list.length) errors.push('Добавьте хотя бы одно условие');
  if (list.length > BANK_RULE_MAX_CONDITIONS) errors.push(`Допустимо не более ${BANK_RULE_MAX_CONDITIONS} условий`);
  list.forEach((condition) => validateCondition(condition, errors));
  const actions = rule.actions || {};
  if (!actions || typeof actions !== 'object' || Array.isArray(actions)) errors.push('Некорректные действия правила');
  const allowedActionKeys = new Set(['businessId', 'category', 'methodOverride', 'counterpartyOverride', 'owner', 'comment', 'tags', 'links']);
  Object.keys(actions).forEach((key) => { if (!allowedActionKeys.has(key)) errors.push(`Действие ${key} не разрешено`); });
  if (actions.businessId !== undefined && (typeof actions.businessId !== 'string' || !text(actions.businessId, 63) || actions.businessId.length > 63)) errors.push('Некорректный бизнес');
  if (actions.category !== undefined && (typeof actions.category !== 'string' || actions.category.length > 120)) errors.push('Категория слишком длинная');
  if (actions.owner !== undefined && (typeof actions.owner !== 'string' || actions.owner.length > 128)) errors.push('Некорректный владелец');
  if (actions.links !== undefined) {
    const links = actions.links;
    if (!links || typeof links !== 'object' || Array.isArray(links)) errors.push('Некорректные связи');
    else {
      if (Object.keys(links).some((key) => !['playerId', 'companyId', 'contactId', 'dealId', 'event'].includes(key))) errors.push('Связь содержит неизвестное поле');
      for (const key of ['playerId', 'companyId', 'contactId', 'dealId']) {
        if (links[key] !== undefined && (typeof links[key] !== 'string' || !text(links[key], 128) || links[key].length > 128)) errors.push('Некорректная ссылка');
      }
      if (links.event !== undefined) {
        const event = links.event;
        if (!event || typeof event !== 'object' || Array.isArray(event)
          || Object.keys(event).some((key) => !['eventId', 'registrationId', 'budgetLineId', 'purpose', 'amountMinor'].includes(key))) {
          errors.push('Некорректная связь события');
        } else {
          if (!text(event.eventId, 128)) errors.push('Для связи события укажите eventId');
          if (!text(event.purpose, 32)) errors.push('Для связи события укажите назначение');
          for (const key of ['eventId', 'registrationId', 'budgetLineId']) {
            if (event[key] !== undefined && (typeof event[key] !== 'string' || !text(event[key], 128) || event[key].length > 128)) errors.push('Некорректная ссылка события');
          }
          if (event.purpose !== undefined && (typeof event.purpose !== 'string' || event.purpose.length > 120)) errors.push('Назначение события слишком длинное');
          if (event.purpose !== undefined && !['payment', 'deposit', 'expense', 'refund'].includes(event.purpose)) errors.push('Неизвестное назначение события');
          if (['payment', 'deposit', 'refund'].includes(event.purpose) && !text(event.registrationId, 128)) errors.push('Для оплаты, депозита или возврата нужна регистрация');
          if (event.amountMinor !== undefined && (!Number.isSafeInteger(event.amountMinor) || event.amountMinor <= 0)) errors.push('Некорректная сумма события');
        }
      }
    }
  }
  if (rule.decision === 'auto' && (!text(actions.businessId, 63) || !text(actions.category, 120))) {
    errors.push('Для auto обязательны бизнес и категория');
  }
  if (actions.comment !== undefined && (typeof actions.comment !== 'string' || actions.comment.length > 300)) errors.push('Комментарий слишком длинный');
  if (actions.counterpartyOverride !== undefined && (typeof actions.counterpartyOverride !== 'string' || actions.counterpartyOverride.length > 160)) errors.push('Контрагент слишком длинный');
  if (actions.tags !== undefined && (!Array.isArray(actions.tags) || actions.tags.length > 10
    || actions.tags.some((tag) => typeof tag !== 'string' || !text(tag, 32) || tag.length > 32))) errors.push('Некорректные метки');
  if (actions.methodOverride !== undefined && !['account', 'card', 'sbp', 'cash', 'other'].includes(actions.methodOverride)) {
    errors.push('Неизвестный способ оплаты');
  }
  if (rule.autoLimits?.maxAmountMinor !== undefined
    && (!Number.isSafeInteger(rule.autoLimits.maxAmountMinor) || rule.autoLimits.maxAmountMinor < 0)) errors.push('Некорректный лимит правила');
  if (rule.autoLimits !== undefined && (!rule.autoLimits || typeof rule.autoLimits !== 'object' || Array.isArray(rule.autoLimits)
    || Object.keys(rule.autoLimits).some((key) => !['maxAmountMinor', 'maxTransactionsPerDay'].includes(key)))) errors.push('Некорректные лимиты правила');
  if (rule.autoLimits?.maxTransactionsPerDay !== undefined
    && (!Number.isSafeInteger(rule.autoLimits.maxTransactionsPerDay) || rule.autoLimits.maxTransactionsPerDay < 0)) errors.push('Некорректный дневной лимит правила');
  return { ok: errors.length === 0, errors, rule };
}

function compareCondition(actual, condition) {
  if (actual === undefined || actual === null || actual === '') return 'unknown';
  const expected = condition.value;
  if (condition.op === 'range') return actual >= expected && actual <= condition.valueTo ? 'true' : 'false';
  if (condition.op === 'exact') {
    if (typeof actual === 'number') return actual === expected ? 'true' : 'false';
    return normalizeBankText(actual) === normalizeBankText(expected) ? 'true' : 'false';
  }
  const haystack = normalizeBankText(actual);
  if (condition.op === 'contains') return haystack.includes(normalizeBankText(expected)) ? 'true' : 'false';
  if (condition.op === 'regex') return new RegExp(String(expected), 'iu').test(String(actual)) ? 'true' : 'false';
  return 'false';
}

function groupState(states, kind) {
  if (!states.length) return 'true';
  if (kind === 'all') return states.includes('false') ? 'false' : states.includes('unknown') ? 'unknown' : 'true';
  if (kind === 'any') return states.includes('true') ? 'true' : states.includes('unknown') ? 'unknown' : 'false';
  return states.includes('true') ? 'false' : states.includes('unknown') ? 'unknown' : 'true';
}

function evidenceWeight(condition) {
  if (STRONG_FIELDS.has(condition.field) && condition.op === 'exact') return { kind: 'strong', weight: 0.55 };
  if (CONTEXT_FIELDS.has(condition.field) && ['exact', 'contains', 'regex'].includes(condition.op)) return { kind: 'context', weight: condition.op === 'exact' ? 0.4 : 0.35 };
  if (condition.field === 'schemeName' || condition.field === 'transactionTypeCode') return { kind: 'context', weight: 0.25 };
  if (condition.field === 'currency') return { kind: 'context', weight: 0.15 };
  return { kind: 'weak', weight: condition.field === 'amountMinor' ? 0.12 : 0.1 };
}

function evaluateOne(rule, signals) {
  const groups = {};
  const matched = [];
  const unknown = [];
  for (const kind of ['all', 'any', 'none']) {
    const conditions = Array.isArray(rule.conditions?.[kind]) ? rule.conditions[kind] : [];
    const states = conditions.map((condition) => {
      const state = compareCondition(valueAt(signals, condition.field), condition);
      if (state === 'true') matched.push(condition);
      if (state === 'unknown') unknown.push(condition.field);
      return state;
    });
    groups[kind] = groupState(states, kind);
  }
  const state = groups.all === 'false' || groups.any === 'false' || groups.none === 'false' ? 'false'
    : groups.all === 'unknown' || groups.any === 'unknown' || groups.none === 'unknown' ? 'unknown' : 'true';
  const evidence = matched.map(evidenceWeight);
  const strongCount = evidence.filter((item) => item.kind === 'strong').length;
  const contextCount = evidence.filter((item) => item.kind === 'context').length;
  const onlyWeak = matched.length > 0 && matched.every((item) => WEAK_FIELDS.has(item.field));
  let confidence = evidence.reduce((sum, item) => sum + item.weight, 0);
  const links = rule.actions?.links || {};
  if (links.playerId || links.contactId || links.companyId || links.dealId) confidence += 0.1;
  if (links.event?.eventId && links.event?.registrationId) confidence += 0.15;
  confidence = Math.min(1, Math.round(confidence * 100) / 100);
  if (onlyWeak) confidence = Math.min(confidence, 0.6);
  return { rule, state, matched, unknown: [...new Set(unknown)], confidence, strongCount, contextCount, onlyWeak };
}

function sameActions(left, right) {
  return canonicalJson(left || {}) === canonicalJson(right || {});
}

export function evaluateBankRules(signals, rules, settings = DEFAULT_BANK_RULE_SETTINGS, context = {}) {
  const ordered = (rules || []).filter((rule) => rule?.enabled !== false && rule?.deleted !== true)
    .map((rule) => validateBankRule(rule)).filter((result) => result.ok).map((result) => result.rule)
    .sort((a, b) => Number(b.priority) - Number(a.priority) || Number(a.order) - Number(b.order)
      || String(a.id).localeCompare(String(b.id)));
  const evaluated = ordered.map((rule) => evaluateOne(rule, signals || {}));
  const matches = [];
  for (const item of evaluated) {
    if (item.state !== 'true') continue;
    if (matches.length && Number(item.rule.priority) < Number(matches[0].rule.priority)) break;
    matches.push(item);
  }
  if (!matches.length) {
    return {
      decision: 'manual', state: evaluated.some((item) => item.state === 'unknown') ? 'unknown' : 'unmatched',
      confidence: 0, autoEligible: false, conflict: false,
      missingSignals: [...new Set(evaluated.flatMap((item) => item.unknown))], matches: [],
    };
  }
  const selected = matches[0];
  const conflicting = matches.filter((item) => item.rule.decision !== selected.rule.decision
    || !sameActions(item.rule.actions, selected.rule.actions));
  const duplicates = matches.filter((item, index) => index > 0 && item.rule.decision === selected.rule.decision
    && sameActions(item.rule.actions, selected.rule.actions));
  const amountMinor = Number(signals?.amountMinor || 0);
  const direction = String(signals?.direction || '');
  const maxByDirection = Number(settings?.maxAmountMinor?.[direction] ?? 0);
  const ruleMax = Number(selected.rule.autoLimits?.maxAmountMinor ?? Number.MAX_SAFE_INTEGER);
  const limitOk = amountMinor > 0 && maxByDirection > 0 && amountMinor <= maxByDirection && amountMinor <= ruleMax
    && (settings.allowedDirections || []).includes(direction)
    && Number(context.transactionsThisRun || 0) < Number(settings.maxTransactionsPerRun || 0)
    && Number(context.transactionsToday || 0) < Number(settings.maxTransactionsPerDay || 0)
    && Number(context.totalAmountMinorToday || 0) + amountMinor <= Number(settings.maxTotalAmountMinorPerDay || 0)
    && Number(context.ruleTransactionsToday || 0) < Number(selected.rule.autoLimits?.maxTransactionsPerDay ?? Number.MAX_SAFE_INTEGER);
  const strongEnough = selected.strongCount >= 1 || selected.contextCount >= 2;
  const complete = selected.unknown.length === 0;
  const autoEligible = selected.rule.decision === 'auto' && settings.autoEnabled === true
    && !conflicting.length && complete && !selected.onlyWeak && selected.confidence >= 0.95
    && strongEnough && limitOk && !!selected.rule.actions?.businessId && !!selected.rule.actions?.category;
  return {
    decision: autoEligible ? 'auto' : selected.rule.decision === 'auto' ? 'suggest' : selected.rule.decision,
    requestedDecision: selected.rule.decision,
    state: conflicting.length ? 'conflict' : complete ? 'matched' : 'unknown',
    confidence: selected.confidence,
    autoEligible,
    conflict: conflicting.length > 0,
    amountOnly: selected.onlyWeak,
    strongEvidenceCount: selected.strongCount,
    contextEvidenceCount: selected.contextCount,
    limitOk,
    appliedRuleId: selected.rule.id,
    appliedRuleVersion: selected.rule.version,
    actions: structuredClone(selected.rule.actions || {}),
    missingSignals: selected.unknown,
    matches: matches.map((item) => ({
      ruleId: item.rule.id, version: item.rule.version, decision: item.rule.decision,
      confidence: item.confidence,
      state: item === selected ? 'selected' : conflicting.includes(item) ? 'conflicting' : 'duplicate',
    })),
    duplicateRuleIds: duplicates.map((item) => item.rule.id),
  };
}

export function aggregateBankRulePreview(transactions, rules, settings = DEFAULT_BANK_RULE_SETTINGS) {
  const summary = { total: 0, matched: 0, autoEligible: 0, conflict: 0, missingSignals: 0, ignored: 0, manual: 0, exampleCount: 0 };
  for (const transaction of (transactions || []).slice(0, 5000)) {
    const result = evaluateBankRules(transaction.bankSignals || {}, rules, settings);
    summary.total++;
    if (result.state === 'matched') summary.matched++;
    if (result.autoEligible) summary.autoEligible++;
    if (result.conflict) summary.conflict++;
    if (result.missingSignals.length) summary.missingSignals++;
    if (result.decision === 'ignore') summary.ignored++;
    if (result.decision === 'manual') summary.manual++;
  }
  summary.exampleCount = Math.min(5, summary.matched);
  return summary;
}

export function publicBankRuleEvaluation(result = {}) {
  const actions = {};
  if (typeof result.actions?.businessId === 'string') actions.businessId = result.actions.businessId;
  if (typeof result.actions?.category === 'string') actions.category = result.actions.category;
  return {
    decision: result.decision,
    requestedDecision: result.requestedDecision,
    state: result.state,
    confidence: result.confidence,
    autoEligible: result.autoEligible === true,
    conflict: result.conflict === true,
    amountOnly: result.amountOnly === true,
    limitOk: result.limitOk === true,
    appliedRuleId: result.appliedRuleId,
    appliedRuleVersion: result.appliedRuleVersion,
    actions,
    missingSignals: (result.missingSignals || []).map(() => 'missing'),
    matches: (result.matches || []).map(({ ruleId, version, decision, confidence, state }) => ({ ruleId, version, decision, confidence, state })),
  };
}

export function bankRuleEvaluationToken(transaction = {}, result = {}) {
  const safe = publicBankRuleEvaluation(result);
  const source = canonicalJson({
    queueId: String(transaction.id || ''), updated: Number(transaction.updated || 0),
    decision: safe.decision, requestedDecision: safe.requestedDecision, state: safe.state,
    conflict: safe.conflict, appliedRuleId: safe.appliedRuleId,
    appliedRuleVersion: safe.appliedRuleVersion, actions: safe.actions,
  });
  let first = 2166136261;
  let second = 2246822507;
  for (let index = 0; index < source.length; index++) {
    first = Math.imul(first ^ source.charCodeAt(index), 16777619);
    second = Math.imul(second ^ source.charCodeAt(index), 3266489909);
  }
  return `e1:${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

export function safeBankRuleSettings(source = {}) {
  const settings = {
    ...DEFAULT_BANK_RULE_SETTINGS,
    id: text(source.id || DEFAULT_BANK_RULE_SETTINGS.id, 128),
    settingsVersion: source.settingsVersion,
    autoEnabled: source.autoEnabled,
    allowedDirections: Array.isArray(source.allowedDirections) ? source.allowedDirections : DEFAULT_BANK_RULE_SETTINGS.allowedDirections,
    maxAmountMinor: source.maxAmountMinor,
    maxTransactionsPerRun: source.maxTransactionsPerRun,
    maxTransactionsPerDay: source.maxTransactionsPerDay,
    maxTotalAmountMinorPerDay: source.maxTotalAmountMinorPerDay,
    ...(source.settingsId ? { settingsId: text(source.settingsId, 128) } : {}),
    ...(source.updatedBy ? { updatedBy: text(source.updatedBy, 128) } : {}),
    ...(Number.isFinite(Number(source.created)) ? { created: Number(source.created) } : {}),
    ...(Number.isFinite(Number(source.updated)) ? { updated: Number(source.updated) } : {}),
  };
  settings.allowedDirections = (settings.allowedDirections || []).filter((value) => ['income', 'expense'].includes(value));
  const safeInt = (value, max = Number.MAX_SAFE_INTEGER) => {
    const number = Number(value);
    return Number.isSafeInteger(number) ? Math.min(max, Math.max(0, number)) : 0;
  };
  settings.maxAmountMinor = {
    income: safeInt(settings.maxAmountMinor?.income),
    expense: safeInt(settings.maxAmountMinor?.expense),
  };
  for (const key of ['maxTransactionsPerRun', 'maxTransactionsPerDay', 'maxTotalAmountMinorPerDay']) {
    settings[key] = safeInt(settings[key], key === 'maxTotalAmountMinorPerDay' ? Number.MAX_SAFE_INTEGER : 10000);
  }
  settings.autoEnabled = settings.autoEnabled === true;
  settings.settingsVersion = Math.max(1, Math.floor(Number(settings.settingsVersion || 1)));
  return settings;
}
