import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, store, css, sw, config] = await Promise.all([
  readFile(new URL('../js/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/store.js', import.meta.url), 'utf8'),
  readFile(new URL('../css/style.css', import.meta.url), 'utf8'),
  readFile(new URL('../sw.js', import.meta.url), 'utf8'),
  readFile(new URL('../config.js', import.meta.url), 'utf8'),
]);

test('Необработанные содержат Очередь, Настройки и Журнал', () => {
  const block = app.slice(app.indexOf('function renderFinBank'), app.indexOf('function renderFinOps'));
  assert.match(block, /\['queue', 'Очередь'\]/);
  assert.match(block, /\['settings', 'Настройки'\]/);
  assert.match(block, /\['journal', 'Журнал'\]/);
  assert.match(block, /data-bank-subtab/);
  assert.match(block, /Автопроведение выключено/);
  assert.match(block, /Безопасные лимиты/);
  assert.match(block, /Проверить на очереди/);
});

test('заметная кнопка настроек правил и скриптов всегда открывает автоматизацию и не исчезает на телефоне', () => {
  const block = app.slice(app.indexOf('function renderFinBank'), app.indexOf('function renderFinOps'));
  assert.match(block, /data-bank-rules-entry>⚙ Настройки правил\/скриптов/);
  assert.match(block, /Правила, автоматизация и журнал/);
  assert.match(block, /querySelector\('\[data-bank-rules-entry\]'\)[\s\S]*S\.bankSubTab = 'settings'/);
  assert.match(css, /\.bank-rules-entry \{ min-height: 44px/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.bank-rules-entry \{ width: 100%; justify-content: center/);
});

test('ручное проведение сохранено, а предложение имеет отдельную подтверждаемую кнопку', () => {
  const block = app.slice(app.indexOf('function openBankTransaction'), app.indexOf('function renderFinOps'));
  assert.match(block, /S\.store\.processBankTransaction/);
  assert.match(block, /Провести операцию/);
  assert.match(block, /bank-apply-suggestion/);
  assert.match(block, /S\.store\.bankRuleApplySuggestion/);
  assert.match(block, /submit\.disabled = true/);
});

test('из операции создаётся только suggest-черновик по безопасным видимым признакам', () => {
  assert.match(app, /id="bank-create-rule"/);
  assert.match(app, /openBankRuleForm\(null, transaction\)/);
  assert.match(app, /Создаётся безопасный черновик по направлению и сумме/);
  assert.match(app, /Сумма без сильного признака никогда не проводится автоматически/);
});

test('редактор не стирает неподдерживаемые условия и действия расширенного правила', () => {
  const block = app.slice(app.indexOf('function openBankRuleForm'), app.indexOf('async function renderBankRuleJournal'));
  assert.match(block, /const advancedRule = !!rule/);
  assert.match(block, /У этого правила есть расширенные условия или действия/);
  assert.match(block, /conditions: advancedRule \? rule\.conditions/);
  assert.match(block, /actions: advancedRule \? rule\.actions/);
});

test('редактор правил покрывает реквизиты, владельца и связи с CRM/событиями', () => {
  const block = app.slice(app.indexOf('function openBankRuleForm'), app.indexOf('async function renderBankRuleJournal'));
  for (const field of ['recipientPhone', 'recipientInn', 'senderPhone', 'senderInn', 'owner', 'counterpartyOverride', 'playerId', 'companyId', 'contactId', 'dealId', 'eventId', 'registrationId']) {
    assert.match(block, new RegExp(`name="${field}"`), field);
  }
  assert.match(block, /normalizePhone/);
  assert.match(block, /normalizeInn/);
  assert.match(block, /Для оплаты, депозита или возврата выберите регистрацию участника/);
});

test('банковская finance открывается только для чтения и ведёт в журнал', () => {
  const block = app.slice(app.indexOf('function openFinForm'), app.indexOf('function viewMoney'));
  assert.match(block, /const bankManaged/);
  assert.match(block, /защищена от обычного редактирования и удаления/);
  assert.match(block, /id="open-bank-journal"/);
  assert.match(block, /S\.bankSubTab = 'journal'/);
  assert.ok(block.indexOf('if (bankManaged)') < block.indexOf('<form id="ent-form">'));
});

test('сохранение лимитов не расширяет разрешённые направления auto', () => {
  assert.match(app, /allowedDirections: Array\.isArray\(settings\.allowedDirections\) \? \[\.\.\.settings\.allowedDirections\]/);
  assert.doesNotMatch(app, /autoEnabled: nextAuto, allowedDirections: \['income', 'expense'\]/);
});

test('поздний ответ журнала не перезаписывает другой экран финансов', () => {
  assert.match(app, /currentRoute\(\) !== 'finance' \|\| S\.finTab !== 'bank' \|\| S\.bankSubTab !== 'journal'/);
});

test('включение auto-правила требует dry-run и явного подтверждения именно этого результата', () => {
  const block = app.slice(app.indexOf('function openBankRuleForm'), app.indexOf('async function renderBankRuleJournal'));
  assert.match(block, /bankRuleDryRun\(S\.token, next, expectedVersion\)/);
  assert.match(block, /activationToken/);
  assert.match(block, /confirm\(/);
  assert.match(block, /dryRun\.summary/);
});

test('журнал показывает безопасную ориентацию, загружает следующие страницы и даёт явную очистку полей', () => {
  const journal = app.slice(app.indexOf('async function renderBankRuleJournal'), app.indexOf('function openBankCorrection'));
  const correction = app.slice(app.indexOf('function openBankCorrection'), app.indexOf('async function reverseBankApplication'));
  for (const field of ['auditRef', 'operationDate', 'businessId', 'category', 'method']) assert.match(journal, new RegExp(field));
  assert.match(journal, /nextOffset/);
  assert.match(journal, /bank-journal-more/);
  assert.match(correction, /name="clearCounterparty"/);
  assert.match(correction, /name="clearComment"/);
  assert.match(correction, /value="__clear__"/);
  assert.match(correction, /patch\.owner = null/);
  assert.match(correction, /patch\.counterparty = null/);
  assert.match(correction, /patch\.comment = null/);
});

test('preview показывает только агрегаты, а журнал предупреждает о privacy', () => {
  assert.match(app, /Имена, суммы, телефоны, счета и банковские идентификаторы в результат не включены/);
  assert.match(app, /Журнал не содержит банковских идентификаторов, реквизитов, имён, телефонов, ИНН и сумм/);
  assert.doesNotMatch(app.slice(app.indexOf('async function renderBankRuleJournal'), app.indexOf('function openBankCorrection')), /bankId|bankSignals|accountKey|amountMinor/);
});

test('RemoteStore покрывает полный специальный API правил', () => {
  for (const method of [
    'bankRulesList', 'bankRuleSave', 'bankRuleEnable', 'bankRuleDelete', 'bankRuleSettingsGet', 'bankRuleSettingsUpdate',
    'bankRulePreviewTransaction', 'bankRuleDryRun', 'bankRuleApplySuggestion', 'bankRuleRejectSuggestion',
    'bankRuleIgnore', 'bankRuleManual', 'bankRuleReevaluate', 'bankRuleJournal', 'bankRuleCorrect', 'bankRuleReverse',
  ]) assert.match(store, new RegExp(`${method}\\(`), method);
});

test('правило архивируется версионно и остаётся в истории', () => {
  const block = app.slice(app.indexOf('function renderBankRuleSettings'), app.indexOf('async function renderBankRuleJournal'));
  assert.match(block, /id="bank-rule-delete"/);
  assert.match(block, /S\.store\.bankRuleDelete/);
  assert.match(block, /В архив/);
  assert.match(block, /В архиве/);
});

test('на мобильном правила и журнал не теряют кнопки, preview становится сеткой 2×2', () => {
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.bank-rule-row \.btn, \.bank-journal-row \.btn \{ width: 100%/);
  assert.match(css, /\.bank-preview-cards \{ grid-template-columns: repeat\(2/);
  assert.match(css, /\.bank-pending-row \.btn \{ width: 100%/);
});

test('frontend cache и версия подняты вместе с bank-rules', () => {
  assert.match(sw, /const CACHE = 'monetki-v27'/);
  assert.match(sw, /'\.\/js\/bank-rules\.js'/);
  assert.match(sw, /'\.\/supabase\/functions\/api\/bank-rules\.js'/);
  assert.match(config, /version:\s*"0\.6\.0"/);
});
