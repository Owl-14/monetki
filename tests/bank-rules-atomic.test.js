import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/009_bank_rules.sql', import.meta.url), 'utf8');
const stockMigration = await readFile(new URL('../supabase/migrations/004_atomic_stock_operations.sql', import.meta.url), 'utf8');
const legacyProcessMigration = await readFile(new URL('../supabase/migrations/005_process_bank_transaction.sql', import.meta.url), 'utf8');
const recoveryMigration = await readFile(new URL('../supabase/migrations/006_recover_hidden_bank_transactions.sql', import.meta.url), 'utf8');

test('DB задаёт уникальность bankId, версий, applications и relations', () => {
  assert.doesNotMatch(migration, /jsonb_object_length/);
  for (const index of [
    'records_finance_bank_id_unique', 'records_bank_queue_bank_id_unique',
    'records_bank_rule_version_unique', 'records_bank_rule_setting_version_unique', 'records_bank_application_key_unique',
    'records_finance_relation_key_unique', 'records_finance_relation_unique',
  ]) assert.match(migration, new RegExp(`create unique index if not exists ${index}`), index);
  assert.match(migration, /Найдены дубли finance\.bankId/);
  assert.match(migration, /Найдены дубли bankTransactions\.bankId/);
});

test('enqueue и apply используют один deadlock-safe порядок advisory → row lock', () => {
  const enqueue = migration.slice(migration.indexOf('function public.bank_enqueue_transaction'), migration.indexOf('function public.bank_rule_save'));
  const apply = migration.slice(migration.indexOf('function public.apply_bank_rule_transaction'), migration.indexOf('function public.correct_bank_rule_transaction'));
  assert.ok(enqueue.indexOf('pg_advisory_xact_lock') < enqueue.indexOf('for update'));
  assert.ok(apply.indexOf('pg_advisory_xact_lock') < apply.indexOf('for update'));
  assert.match(enqueue, /entity = 'finance'[\s\S]*entity = 'bankTransactions'/);
  assert.match(enqueue, /amountMinor[\s\S]*visible_amount[\s\S]*direction/);
});

test('все банковские мутации берут единый barrier первым, до bankId и row locks', () => {
  const functionNames = [
    'bank_enqueue_transaction', 'bank_rule_save', 'bank_rule_settings_save', 'bank_rule_append_run',
    'apply_bank_rule_transaction', 'correct_bank_rule_transaction', 'reverse_bank_rule_transaction',
    'bank_rule_restore_graph', 'restore_monetki_backup',
  ];
  functionNames.forEach((name, index) => {
    const start = migration.indexOf(`function public.${name}`);
    const nextStarts = functionNames.slice(index + 1).map((next) => migration.indexOf(`function public.${next}`)).filter((value) => value > start);
    const end = nextStarts.length ? Math.min(...nextStarts) : migration.length;
    const block = migration.slice(start, end);
    const barrier = block.indexOf("pg_advisory_xact_lock(hashtext('bank_mutation_barrier'))");
    assert.ok(barrier > 0, name);
    const laterAdvisory = block.indexOf('pg_advisory_xact_lock', barrier + 1);
    const rowLock = block.indexOf('for update');
    if (laterAdvisory >= 0) assert.ok(barrier < laterAdvisory, name);
    if (rowLock >= 0) assert.ok(barrier < rowLock, name);
  });
  for (const [name, source] of [['process_bank_transaction', legacyProcessMigration], ['deploy recovery', recoveryMigration]]) {
    const barrier = source.indexOf("pg_advisory_xact_lock(hashtext('bank_mutation_barrier'))");
    assert.ok(barrier > 0 && barrier < source.indexOf('for update'), name);
  }
  const fullRestore = migration.slice(migration.indexOf('function public.restore_monetki_backup'));
  assert.ok(fullRestore.indexOf('bank_mutation_barrier') < fullRestore.indexOf('insert into public.records'));
});

test('restore восстанавливает правила и очередь одним RPC и сохраняет порядок bankId → finance', () => {
  const restore = migration.slice(migration.indexOf('function public.bank_rule_restore_graph'));
  assert.match(restore, /p_graph->'bankTransactions'/);
  assert.match(restore, /perform public\.bank_enqueue_transaction\(v_item\)/);
  const relation = restore.slice(restore.indexOf("if v_entity = 'financeRelations'"), restore.indexOf("select data into v_existing"));
  assert.ok(relation.indexOf('pg_advisory_xact_lock') < relation.lastIndexOf('for update'));
});

test('полный backup восстанавливается одной транзакцией: обычные записи → bank finance → events', () => {
  const restore = migration.slice(migration.indexOf('function public.restore_monetki_backup'));
  assert.match(restore, /p_graph->'ordinary'/);
  assert.match(restore, /p_graph->'bank'/);
  assert.match(restore, /p_graph->'events'/);
  assert.match(migration.slice(migration.indexOf('function public.bank_rule_restore_graph'), migration.indexOf('function public.restore_monetki_backup')), /p_graph->'bankFinance'/);
  const bankAt = restore.indexOf('bank_rule_restore_graph');
  const eventAt = restore.indexOf('event_restore_graph');
  assert.ok(bankAt > 0 && eventAt > bankAt);
  assert.match(migration, /revoke all on function public\.restore_monetki_backup\(jsonb\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.restore_monetki_backup\(jsonb\) to service_role/);
});

test('складская проводка блокирует связанную finance до создания движения', () => {
  const movement = stockMigration.slice(stockMigration.indexOf('function stock_apply_movement'));
  assert.match(movement, /v_finance jsonb/);
  assert.match(movement, /entity = 'finance'[\s\S]*for update/);
  assert.ok(movement.indexOf("entity = 'finance'") < movement.indexOf("values ('stockMovements'"));
});

test('apply атомарно создаёт finance, relations, event allocation и audit, затем удаляет queue', () => {
  const apply = migration.slice(migration.indexOf('function public.apply_bank_rule_transaction'), migration.indexOf('function public.correct_bank_rule_transaction'));
  const financeAt = apply.indexOf("values ('finance'");
  const relationAt = apply.indexOf("values ('financeRelations'");
  const eventAt = apply.indexOf('event_allocate_finance');
  const auditAt = apply.lastIndexOf("values ('bankRuleApplications'");
  const deleteAt = apply.lastIndexOf("delete from public.records where entity = 'bankTransactions'");
  assert.ok(financeAt > 0 && relationAt > financeAt && eventAt > relationAt && auditAt > eventAt && deleteAt > auditAt);
  assert.match(apply, /requestChecksum/);
  assert.match(apply, /alreadyProcessed/);
  assert.match(apply, /expectedFingerprint/);
  assert.match(apply, /expectedUpdated/);
});

test('auto off/версии/unknown/conflict/amount-only и лимиты проверяются внутри SQL', () => {
  for (const token of [
    "autoEnabled", "settingsVersion", "appliedRuleVersion", "confidence", "amountOnly",
    "conflict", "missingSignals", "maxAmountMinor", "maxTransactionsPerDay",
    "maxTotalAmountMinorPerDay", "maxTransactionsPerRun", "maxTransactionsPerDay",
  ]) assert.match(migration, new RegExp(token), token);
  assert.match(migration, /state', 'downgraded'/);
  assert.match(migration, /time zone 'Europe\/Moscow'/);
  assert.match(migration, /v_unique_strong/);
  assert.match(migration, /v_unique_context/);
  assert.match(migration, /v_duplicate_evidence/);
  assert.match(migration, /duplicateEvidenceCount/);
});

test('версии, аудит, запуски и relations неизменяемы триггером', () => {
  assert.match(migration, /bankRuleVersions', 'bankRuleSettingVersions', 'bankRuleApplications', 'bankRuleRuns', 'financeRelations'/);
  assert.match(migration, /v_mode not in \('save', 'apply', 'queue_state', 'run', 'correct', 'reverse', 'restore'\)/);
  assert.match(migration, /if tg_op <> 'INSERT' then raise exception 'История банковских правил неизменяема'/);
  assert.match(migration, /Операция, созданная правилом, изменяется только безопасным действием/);
});

test('correction сохраняет денежные поля, reverse блокирует downstream и идемпотентен', () => {
  const correct = migration.slice(migration.indexOf('function public.correct_bank_rule_transaction'), migration.indexOf('function public.reverse_bank_rule_transaction'));
  const reverse = migration.slice(migration.indexOf('function public.reverse_bank_rule_transaction'), migration.indexOf('function public.bank_rule_restore_graph'));
  assert.match(correct, /key not in \('category', 'method', 'owner', 'comment', 'counterparty'\)/);
  assert.match(correct, /md5\(v_finance::text\)/);
  assert.doesNotMatch(correct, /p_patch\s*(?:->>?|\?)\s*'(?:amount|bankId|type)'/);
  assert.match(reverse, /entity = 'financeRelations'/);
  assert.match(reverse, /entity = 'eventFinanceAllocations'/);
  assert.match(reverse, /entity = 'stockMovements'/);
  assert.match(reverse, /bankRuleState', 'pending'/);
  assert.match(reverse, /bankOriginal/);
  assert.match(reverse, /bankSignalFingerprint/);
  assert.match(correct, /sourceApplicationId/);
  assert.match(correct, /patchChecksum/);
  assert.match(correct, /state' in \('applied', 'corrected'\)/);
  assert.match(reverse, /state' in \('applied', 'corrected'\)/);
  assert.match(reverse, /alreadyProcessed/);
  assert.match(correct, /jsonb_typeof\(value\) = 'null'/);
  assert.match(correct, /key in \('owner', 'comment', 'counterparty'\)/);
  assert.match(reverse, /legacy_backfill/);
});

test('legacy bank finance получает контролируемый аудит и остаётся доступной только для correction', () => {
  assert.match(migration, /'operation', 'legacy_backfill'/);
  assert.match(migration, /'canReverse', false/);
  assert.match(migration, /bank-application:legacy:/);
  assert.match(migration, /'auditRef', 'legacy-'/);
  const correct = migration.slice(migration.indexOf('function public.correct_bank_rule_transaction'), migration.indexOf('function public.reverse_bank_rule_transaction'));
  assert.match(correct, /v_lock_key := case when v_bank_id <> '' then v_bank_id else 'finance:' \|\| v_requested->>'financeId' end/);
  assert.match(correct, /select data into v_finance from public\.records where entity = 'finance' and id = v_requested->>'financeId'/);
  assert.doesNotMatch(correct, /if coalesce\(v_bank_id, ''\) = '' then raise exception 'Финансовая операция не найдена'/);
});

test('повторный deploy снимает immutable trigger до seed, а legacy сумма имеет безопасный fallback', () => {
  const firstSeed = migration.indexOf("values ('bankRuleSettings'");
  const firstDrop = migration.indexOf('drop trigger if exists bank_rules_protect_records_trigger');
  assert.ok(firstDrop > 0 && firstDrop < firstSeed);
  const apply = migration.slice(migration.indexOf('function public.apply_bank_rule_transaction'), migration.indexOf('function public.correct_bank_rule_transaction'));
  assert.match(apply, /v_pending->'bankSignals'->>'amountMinor'/);
  assert.match(apply, /round\(coalesce\(\(v_pending->>'amount'\)::numeric, 0\) \* 100\)/);
  assert.match(apply, /'bank-app:' \|\| v_key/);
  assert.match(apply, /v_rule->>'decision' is distinct from 'auto'/);
  assert.match(apply, /v_version->>'decision' is distinct from 'auto'/);
  assert.match(apply, /v_application->>'requestedDecision' is distinct from 'auto'/);
});

test('relations и event allocation жёстко привязаны к finance, бизнесу и idempotency key', () => {
  const apply = migration.slice(migration.indexOf('function public.apply_bank_rule_transaction'), migration.indexOf('function public.correct_bank_rule_transaction'));
  for (const token of ["v_relation->>'financeId'", "v_relation->>'businessId'", "v_relation->>'unit'", "v_relation->>'applicationId'", "p_payload->'event'->>'financeId'", "p_payload->'event'->>'businessId'", "p_payload->'event'->>'unit'"]) {
    assert.match(apply, new RegExp(token.replace(/[>'()]/g, (value) => `\\${value}`)), token);
  }
  assert.match(apply, /v_key \|\| ':'/);
  assert.match(apply, /v_ref->>'businessId' is distinct from v_business_id/);
});

test('каждый RPC закрыт от client roles и разрешён только service_role', () => {
  for (const signature of [
    'bank_enqueue_transaction\\(jsonb\\)', 'bank_rule_save\\(jsonb, integer, text\\)',
    'bank_rule_settings_save\\(jsonb, integer, text\\)', 'bank_rule_append_run\\(jsonb\\)',
    'apply_bank_rule_transaction\\(jsonb\\)', 'correct_bank_rule_transaction\\(text, jsonb, text, text\\)',
    'reverse_bank_rule_transaction\\(text, text, text\\)', 'bank_rule_restore_graph\\(jsonb\\)',
    'restore_monetki_backup\\(jsonb\\)',
  ]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${signature} from public, anon, authenticated`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${signature} to service_role`));
  }
});
