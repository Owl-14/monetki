import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('все действия правил маршрутизируются отдельным admin-only API', async () => {
  const [http, actions] = await Promise.all([
    read('supabase/functions/api/http.ts'), read('supabase/functions/api/bank-rule-actions.ts'),
  ]);
  for (const action of [
    'bank_rules_list', 'bank_rule_save', 'bank_rule_enable', 'bank_rule_delete', 'bank_rule_settings_get',
    'bank_rule_settings_update', 'bank_rule_preview_transaction', 'bank_rule_dry_run',
    'bank_rule_apply_suggestion', 'bank_rule_reject_suggestion', 'bank_rule_ignore',
    'bank_rule_manual', 'bank_rule_reevaluate', 'bank_rule_journal', 'bank_rule_correct', 'bank_rule_reverse',
  ]) assert.match(http, new RegExp(`case "${action}"`), action);
  assert.match(actions, /function adminError[\s\S]*!isAdmin\(user\)/);
  assert.match(actions, /validateActionTargets/);
  assert.match(actions, /scopeWriteError/);
  assert.match(actions, /sameBusiness/);
  assert.doesNotMatch(actions, /error\.message|console\./);
  assert.match(http, /catch \(_error\)[\s\S]*"Ошибка сервера"/);
  assert.doesNotMatch(http, /Ошибка сервера:.*message/);
});

test('bootstrap скрывает bankSignals/bankId и не отдаёт журнал целиком', async () => {
  const [rules, store] = await Promise.all([
    read('supabase/functions/api/rules.js'), read('js/store.js'),
  ]);
  for (const source of [rules, store]) {
    assert.match(source, /bankSignals: _signals/);
    assert.match(source, /bankId: _bankId/);
    assert.match(source, /bankSignalFingerprint: _fingerprint/);
    assert.match(source, /publicBankRuleEvaluation\(evaluation\)/);
    assert.match(source, /bankRuleApplications:\s*\[\]/);
    assert.match(source, /bankRuleRuns:\s*\[\]/);
  }
});

test('системные сущности запрещены в generic CRUD и входят в backup', async () => {
  const rules = await read('supabase/functions/api/rules.js');
  assert.match(rules, /export const BANK_RULE_ENTITIES/);
  assert.match(rules, /BANK_RULE_ENTITIES\.includes\(entity\)/);
  for (const entity of ['bankRules', 'bankRuleVersions', 'bankRuleApplications', 'bankRuleRuns', 'bankRuleSettings', 'bankRuleSettingVersions', 'financeRelations']) {
    assert.match(rules, new RegExp(`"${entity}"`));
  }
});

test('sync сохраняет нормализованный снимок без raw payload и обогащает legacy очередь через RPC', async () => {
  const bank = await read('supabase/functions/api/bank.ts');
  assert.match(bank, /normalizeBankSignals/);
  assert.match(bank, /bankSignalFingerprint/);
  assert.match(bank, /BANK_SIGNAL_HMAC_SECRET/);
  assert.match(bank, /callRpc\("bank_enqueue_transaction"/);
  assert.doesNotMatch(bank, /writeRow\("bankTransactions"/);
  assert.match(bank, /!queuedDuplicate\.bankSignals\?\.schemaVersion/);
});

test('backup restore новых immutable сущностей идёт отдельным графом', async () => {
  const actions = await read('supabase/functions/api/actions.ts');
  assert.match(actions, /!BANK_RULE_ENTITIES\.includes\(entity\)/);
  assert.match(actions, /callRpc\("bank_rule_restore_graph"/);
  assert.match(actions, /bankTransactions: payload\?\.bankTransactions \|\| \[\]/);
  assert.ok(actions.indexOf('for (const item of payload?.bankTransactions || [])') < actions.indexOf('callRpc("bank_rule_restore_graph"'));
});

test('generic server CRUD проверяет существующую finance, а не только входной patch', async () => {
  const actions = await read('supabase/functions/api/actions.ts');
  const update = actions.slice(actions.indexOf('export async function updateItem'), actions.indexOf('export async function deleteItem'));
  const remove = actions.slice(actions.indexOf('export async function deleteItem'), actions.indexOf('export async function createEventFinanceAllocation'));
  assert.match(update, /const before = \(await readAll\(entity\)\)\.find/);
  assert.match(update, /bankManagedFinancePayload\(before\)/);
  assert.match(remove, /const before = \(await readAll\(entity\)\)\.find/);
  assert.match(remove, /bankManagedFinancePayload\(before\)/);
});

test('cron исполняет решения ignore/manual даже при выключенном auto', async () => {
  const actions = await read('supabase/functions/api/bank-rule-actions.ts');
  const auto = actions.slice(actions.indexOf('export async function autoProcessBankQueue'));
  assert.match(auto, /\["ignore", "manual"\]\.includes/);
  assert.match(auto, /queueStateAction\([\s\S]*"cron"/);
  assert.doesNotMatch(auto, /if \(!settings\.autoEnabled\) return/);
});

test('ранний idempotency replay привязан к операции и действию', async () => {
  const actions = await read('supabase/functions/api/bank-rule-actions.ts');
  assert.match(actions, /existingApplicationResult\(idempotencyKey: string, sourceQueueId: string, operation: string\)/);
  assert.match(actions, /application\.sourceQueueId !== sourceQueueId \|\| application\.operation !== operation/);
  assert.match(actions, /sourceQueueId: transaction\.id, operation: "apply"/);
  assert.match(actions, /operation = `queue:\$\{state\}:\$\{reason\}`/);
});
