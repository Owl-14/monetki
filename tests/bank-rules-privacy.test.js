import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { aggregateBankRulePreview, normalizeBankSignals } from '../js/bank-rules.js';
import { visibleBootstrapData } from '../supabase/functions/api/rules.js';

test('admin bootstrap очереди не содержит bankId, bankSignals, accountKey, телефон или ИНН', () => {
  const data = {
    businesses: [{ id: 'dev', active: true, modules: ['finance'] }],
    memberships: [{ employeeId: 'admin', businessId: 'dev', unit: 'dev', active: true }],
    businessOwners: [], employees: [], clients: [], companies: [], contacts: [], leads: [], deals: [], pipelines: [], stages: [], dealItems: [],
    venues: [], players: [], tasks: [], finance: [], staffExpenses: [], cash: [], notifications: [],
    eventTypes: [], events: [], eventRegistrations: [], eventBudgetLines: [], eventFinanceAllocations: [],
    warehouses: [], stockItems: [], stockMovements: [], stockBalances: [], reservations: [], inventories: [],
    bankRules: [], bankRuleVersions: [], bankRuleApplications: [], bankRuleRuns: [], bankRuleSettings: [], bankRuleSettingVersions: [], financeRelations: [],
    bankTransactions: [{
      id: 'queue-safe-id', bankId: 'bank-secret-id', date: '2026-08-05', type: 'income', amount: 5500,
      counterparty: 'Разрешённое имя карточки', comment: 'Разрешённое назначение карточки',
      bankSignals: { sourceAccountKey: 'h1:secret', sender: { phoneE164: '+79051112233', inn: '7707083893' } },
    }],
  };
  const result = visibleBootstrapData({ id: 'admin', role: 'admin' }, data);
  const json = JSON.stringify(result.bankTransactions);
  assert.doesNotMatch(json, /bank-secret-id|h1:secret|79051112233|7707083893|bankSignals|bankId|accountKey/);
  assert.match(json, /Разрешённое имя карточки/);
});

test('aggregate preview не содержит значения операций или rules actions', () => {
  const summary = aggregateBankRulePreview([{
    bankId: 'secret-bank-id', amount: 7777, counterparty: 'Секретное имя',
    bankSignals: { direction: 'income', amountMinor: 777700, sender: { phoneE164: '+79050000000' } },
  }], [], {});
  assert.deepEqual(Object.keys(summary).sort(), ['autoEligible', 'conflict', 'exampleCount', 'ignored', 'manual', 'matched', 'missingSignals', 'total']);
  assert.doesNotMatch(JSON.stringify(summary), /secret|7777|Секрет|79050000000/);
});

test('нормализатор никогда не копирует произвольные поля сырого payload', async () => {
  const signals = await normalizeBankSignals({
    transactionId: 'secret-id', creditDebitIndicator: 'Debit', Amount: { amount: '1.00', currency: 'RUB' },
    token: 'secret-token', raw: { accountId: 'raw-account' }, payload: { customer: 'private' },
  }, { detectedMethod: 'account' });
  const json = JSON.stringify(signals);
  assert.doesNotMatch(json, /secret-id|secret-token|raw-account|private|payload|token|raw/);
});

test('server preview/journal удаляют fingerprints, суммы и action snapshot из ответа', async () => {
  const actions = await readFile(new URL('../supabase/functions/api/bank-rule-actions.ts', import.meta.url), 'utf8');
  assert.match(actions, /function safeApplication/);
  assert.match(actions, /amountMinor: _amount/);
  assert.match(actions, /queueFingerprint: _fingerprint/);
  assert.match(actions, /actionSnapshot: _actions/);
  const shared = await readFile(new URL('../supabase/functions/api/bank-rules.js', import.meta.url), 'utf8');
  assert.match(shared, /missingSignals: \(result\.missingSignals \|\| \[\]\)\.map\(\(\) => 'missing'\)/);
  assert.match(actions, /publicBankRuleEvaluation\(result as Rec\)/);
  assert.doesNotMatch(shared.slice(shared.indexOf('export function publicBankRuleEvaluation'), shared.indexOf('export function safeBankRuleSettings')), /links|phone|inn|accountKey|amountMinor/);
  assert.doesNotMatch(actions.slice(actions.indexOf('export async function bankRuleJournal'), actions.indexOf('export async function correctBankRuleApplication')), /bankSignals|bankId|accountKey/);
});

test('SQL dry-run сохраняет только summary и запрещает банковские поля', async () => {
  const sql = await readFile(new URL('../supabase/migrations/009_bank_rules.sql', import.meta.url), 'utf8');
  const block = sql.slice(sql.indexOf('function public.bank_rule_append_run'), sql.indexOf('function public.apply_bank_rule_transaction'));
  assert.match(block, /jsonb_typeof\(p_run->'summary'\)/);
  assert.match(block, /p_run \? 'bankId'/);
  assert.match(block, /p_run \? 'bankSignals'/);
  assert.match(block, /p_run \? 'amount'/);
});
