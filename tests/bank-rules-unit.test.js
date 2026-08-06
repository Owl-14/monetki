import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BANK_RULE_SETTINGS,
  aggregateBankRulePreview,
  amountToMinor,
  canonicalJson,
  evaluateBankRules,
  normalizeBankSignals,
  normalizeBankText,
  normalizeInn,
  normalizePhone,
  safeBankRuleSettings,
  validateBankRule,
} from '../js/bank-rules.js';

const rule = (patch = {}) => ({
  id: 'bank-rule:test', name: 'Тест', enabled: true, priority: 10, order: 1,
  stopOnMatch: false, decision: 'suggest',
  conditions: { all: [{ field: 'direction', op: 'exact', value: 'income' }], any: [], none: [] },
  actions: { businessId: 'padel', category: 'Оплата клиента' }, version: 1,
  ...patch,
});

const autoSettings = safeBankRuleSettings({
  ...DEFAULT_BANK_RULE_SETTINGS, autoEnabled: true, settingsVersion: 3,
  maxAmountMinor: { income: 2_000_000, expense: 2_000_000 },
  maxTransactionsPerRun: 10, maxTransactionsPerDay: 20, maxTotalAmountMinorPerDay: 5_000_000,
});

test('денежная нормализация работает в целых копейках без float', () => {
  assert.equal(amountToMinor('5500.01'), 550001);
  assert.equal(amountToMinor('5500,1'), 550010);
  assert.equal(amountToMinor(0.1), 10);
  assert.equal(amountToMinor('1.999'), null);
  assert.equal(amountToMinor('Infinity'), null);
});

test('текст, телефон и ИНН нормализуются, маски остаются unknown', () => {
  assert.equal(normalizeBankText('  ЁЛКА\tООО  '), 'ёлка ооо');
  assert.equal(normalizePhone('8 (905) 111-22-33'), '+79051112233');
  assert.equal(normalizePhone('+7 905 ***-22-33'), '');
  assert.equal(normalizeInn('7707083893'), '7707083893');
  assert.equal(normalizeInn('7707****93'), '');
});

test('bankSignals содержит только allowlist и HMAC-псевдонимы счетов', async () => {
  const signals = await normalizeBankSignals({
    transactionId: 'bank-secret-id', creditDebitIndicator: 'Credit',
    Amount: { amount: '5500.00', currency: 'rub' }, transactionTypeCode: 'СБП',
    DebtorParty: { name: 'Иван Иванов', inn: '7707083893', phone: '+79051112233', secret: 'raw-secret' },
    DebtorAccount: { schemeName: 'RU.CBR.CellphoneNumber', identification: '+79051112233', number: '40817810000000000001' },
    CreditorAccount: { identification: '40702810000000000002' },
    description: '  Оплата турнира  ', payload: { token: 'secret' },
  }, { sourceAccountId: 'source-account-raw', detectedMethod: 'sbp', accountKey: async (value) => `h1:${value.length}` });
  assert.equal(signals.amountMinor, 550000);
  assert.equal(signals.currency, 'RUB');
  assert.equal(signals.sender.phoneE164, '+79051112233');
  assert.equal(signals.sender.name, undefined);
  assert.equal(signals.sender.nameNormalized, 'иван иванов');
  assert.equal(signals.sender.accountKey, 'h1:12');
  assert.equal(signals.sourceAccountKey, 'h1:18');
  const json = JSON.stringify(signals);
  assert.doesNotMatch(json, /Иван Иванов|40817810000000000001|40702810000000000002|source-account-raw|raw-secret|bank-secret-id|payload|token/);
});

test('DSL запрещает неизвестные поля, неверный диапазон и опасный regex', () => {
  assert.equal(validateBankRule(rule()).ok, true);
  assert.match(validateBankRule(rule({ conditions: { all: [{ field: 'raw.payload', op: 'exact', value: 'x' }] } })).errors.join(' '), /не разрешено/);
  assert.match(validateBankRule(rule({ conditions: { all: [{ field: 'amountMinor', op: 'range', value: 200, valueTo: 100 }] } })).errors.join(' '), /диапазон/);
  assert.match(validateBankRule(rule({ conditions: { all: [{ field: 'descriptionNormalized', op: 'regex', value: '(a+)+' }] } })).errors.join(' '), /безопасный/);
  assert.match(validateBankRule(rule({ conditions: { all: [{ field: 'descriptionNormalized', op: 'regex', value: 'a(?=b)' }] } })).errors.join(' '), /Lookaround/);
});

test('all, any и none нейтральны при отсутствии и поддерживают unknown', () => {
  assert.equal(evaluateBankRules({ direction: 'income' }, [rule()], autoSettings).state, 'matched');
  const any = rule({ conditions: { all: [], any: [{ field: 'currency', op: 'exact', value: 'RUB' }], none: [] } });
  assert.equal(evaluateBankRules({ currency: 'RUB' }, [any], autoSettings).state, 'matched');
  const none = rule({ conditions: { all: [], any: [], none: [{ field: 'currency', op: 'exact', value: 'USD' }] } });
  assert.equal(evaluateBankRules({ currency: 'RUB' }, [none], autoSettings).state, 'matched');
  assert.equal(evaluateBankRules({}, [rule()], autoSettings).state, 'unknown');
});

test('приоритет стабилен, конфликт того же приоритета не скрывается stopOnMatch', () => {
  const first = rule({ id: 'bank-rule:a', decision: 'auto', stopOnMatch: true });
  const second = rule({ id: 'bank-rule:b', decision: 'suggest', actions: { businessId: 'dev', category: 'Прочее' } });
  const result = evaluateBankRules({ direction: 'income' }, [second, first], autoSettings);
  assert.equal(result.conflict, true);
  assert.equal(result.autoEligible, false);
  assert.deepEqual(result.matches.map((item) => item.ruleId), ['bank-rule:a', 'bank-rule:b']);
});

test('одинаковые дубли правил не превращаются в конфликт', () => {
  const first = rule({ id: 'bank-rule:a' });
  const second = rule({ id: 'bank-rule:b' });
  const result = evaluateBankRules({ direction: 'income' }, [second, first], autoSettings);
  assert.equal(result.conflict, false);
  assert.deepEqual(result.duplicateRuleIds, ['bank-rule:b']);
});

test('одна сумма 5500 никогда не auto', () => {
  const amountOnly = rule({
    decision: 'auto',
    conditions: { all: [
      { field: 'direction', op: 'exact', value: 'income' },
      { field: 'amountMinor', op: 'exact', value: 550000 },
    ], any: [], none: [] },
  });
  const result = evaluateBankRules({ direction: 'income', amountMinor: 550000 }, [amountOnly], autoSettings);
  assert.equal(result.amountOnly, true);
  assert.equal(result.autoEligible, false);
  assert.equal(result.decision, 'suggest');
});

test('5500 + точный телефон + однозначные player/event links проходит строгие auto-gates', () => {
  const payment = rule({
    decision: 'auto',
    conditions: { all: [
      { field: 'direction', op: 'exact', value: 'income' },
      { field: 'amountMinor', op: 'exact', value: 550000 },
      { field: 'sender.phoneE164', op: 'exact', value: '+79051112233' },
    ], any: [], none: [] },
    actions: { businessId: 'padel', category: 'Оплата клиента', links: {
      playerId: 'player-1', event: { eventId: 'event-1', registrationId: 'registration-1', purpose: 'payment' },
    } },
  });
  const result = evaluateBankRules({ direction: 'income', amountMinor: 550000, sender: { phoneE164: '+79051112233' } }, [payment], autoSettings);
  assert.equal(result.autoEligible, true);
  assert.equal(result.decision, 'auto');
  assert.equal(evaluateBankRules({ direction: 'income', amountMinor: 550000, sender: {} }, [payment], autoSettings).state, 'unknown');
});

test('перевод Андрею требует expense, sourceAccountKey и точный телефон', () => {
  const andrey = rule({
    decision: 'auto',
    conditions: { all: [
      { field: 'direction', op: 'exact', value: 'expense' },
      { field: 'detectedMethod', op: 'exact', value: 'sbp' },
      { field: 'sourceAccountKey', op: 'exact', value: 'h1:source' },
      { field: 'recipient.phoneE164', op: 'exact', value: '+79050000001' },
    ], any: [], none: [] },
    actions: { businessId: 'dev', category: 'Прочее', owner: 'andrey' },
  });
  const exact = { direction: 'expense', detectedMethod: 'sbp', sourceAccountKey: 'h1:source', recipient: { phoneE164: '+79050000001' }, amountMinor: 100000 };
  assert.equal(evaluateBankRules(exact, [andrey], autoSettings).autoEligible, true);
  assert.equal(evaluateBankRules({ ...exact, direction: 'income' }, [andrey], autoSettings).state, 'unmatched');
  assert.equal(evaluateBankRules({ ...exact, sourceAccountKey: 'h1:other' }, [andrey], autoSettings).state, 'unmatched');
});

test('global off, unknown и лимиты понижают auto до suggest', () => {
  const strong = rule({ decision: 'auto', conditions: { all: [
    { field: 'sourceAccountKey', op: 'exact', value: 'h1:source' },
    { field: 'recipient.phoneE164', op: 'exact', value: '+79050000001' },
  ], any: [], none: [] } });
  const signals = { sourceAccountKey: 'h1:source', recipient: { phoneE164: '+79050000001' }, direction: 'expense', amountMinor: 10000 };
  assert.equal(evaluateBankRules(signals, [strong], DEFAULT_BANK_RULE_SETTINGS).autoEligible, false);
  assert.equal(evaluateBankRules(signals, [strong], autoSettings, { transactionsToday: 20 }).autoEligible, false);
  assert.equal(evaluateBankRules({ sourceAccountKey: 'h1:source' }, [strong], autoSettings).state, 'unknown');
});

test('dry-run возвращает только агрегаты и не меняет вход', () => {
  const queue = [{ bankSignals: { direction: 'income' }, bankId: 'secret', amount: 5500, counterparty: 'Иван' }];
  const before = canonicalJson(queue);
  const summary = aggregateBankRulePreview(queue, [rule()], autoSettings);
  assert.deepEqual(summary, { total: 1, matched: 1, autoEligible: 0, conflict: 0, missingSignals: 0, ignored: 0, manual: 0, exampleCount: 1 });
  assert.equal(canonicalJson(queue), before);
  assert.doesNotMatch(JSON.stringify(summary), /secret|Иван|5500/);
});

test('настройки отбрасывают NaN/Infinity и сохраняют глобальный auto off', () => {
  const settings = safeBankRuleSettings({ autoEnabled: false, maxAmountMinor: { income: Infinity, expense: NaN }, maxTransactionsPerRun: Infinity });
  assert.equal(settings.autoEnabled, false);
  assert.equal(settings.maxAmountMinor.income, 0);
  assert.equal(settings.maxAmountMinor.expense, 0);
  assert.equal(settings.maxTransactionsPerRun, 0);
});
