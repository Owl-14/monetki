import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { DEFAULT_BUSINESSES, DEFAULT_BUSINESS_OWNERS, makeStore, matchBankAutoRule as frontMatch, bankAutoRuleError as frontError } from '../js/store.js';
import { matchBankAutoRule as backMatch, bankAutoRuleError as backError, baseWriteError } from '../supabase/functions/api/rules.js';

class MemoryStorage {
  #values = new Map();
  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
  clear() { this.#values.clear(); }
}

globalThis.window = { MONETKI_CONFIG: {} };
globalThis.localStorage = new MemoryStorage();

const businesses = DEFAULT_BUSINESSES.map((item) => ({ ...item, modules: [...item.modules] }));
const rules = [
  { id: 'r-old', match: 'Padel  Klub', type: 'expense', businessId: 'padel', category: 'Аренда', active: true, created: 1 },
  { id: 'r-new', match: 'klub', type: 'any', businessId: 'dev', category: 'Прочее', active: true, created: 2 },
  { id: 'r-off', match: 'ёлка', type: 'any', businessId: 'dev', category: 'Прочее', active: false, created: 0 },
  { id: 'r-income', match: 'зерно', type: 'income', businessId: 'dev', category: 'Оплата клиента', active: true, created: 3 },
];

test('правило ищет текст в контрагенте и назначении без учёта регистра, пробелов и ё', () => {
  for (const match of [frontMatch, backMatch]) {
    assert.equal(match({ type: 'expense', counterparty: 'ООО PADEL KLUB', comment: '' }, rules, businesses)?.id, 'r-old');
    assert.equal(match({ type: 'income', counterparty: '', comment: 'оплата padel klub' }, rules, businesses)?.id, 'r-new');
    assert.equal(match({ type: 'expense', counterparty: 'Кофейня «Зерно»' }, rules, businesses), null);
    assert.equal(match({ type: 'income', counterparty: 'Кофейня «Зерно»' }, rules, businesses)?.id, 'r-income');
    assert.equal(match({ type: 'income', counterparty: 'Елка' }, rules, businesses), null, 'выключенное правило не срабатывает');
  }
});

test('правило в архивный бизнес не срабатывает, а без текста или категории не сохраняется', () => {
  const archived = businesses.map((item) => item.id === 'padel' ? { ...item, active: false } : item);
  for (const [match, error] of [[frontMatch, frontError], [backMatch, backError]]) {
    assert.equal(match({ type: 'expense', counterparty: 'PADEL KLUB' }, rules, archived)?.id, 'r-new');
    assert.match(error({ match: ' ', businessId: 'dev', category: 'Прочее' }, businesses), /текст/);
    assert.match(error({ match: 'x', businessId: 'dev', category: '' }, businesses), /категорию/);
    assert.match(error({ match: 'x', businessId: 'nope', category: 'Прочее' }, businesses), /Бизнес/);
  }
  assert.match(baseWriteError({ role: 'staff' }, 'bankAutoRules'), /Только для админа/);
  assert.equal(baseWriteError({ role: 'admin' }, 'bankAutoRules'), null);
});

function storeWithQueue() {
  localStorage.clear();
  localStorage.setItem('monetki_demo_db', JSON.stringify({
    businesses,
    memberships: [
      { id: 'm1', employeeId: 'admin', businessId: 'padel', unit: 'padel', role: 'owner', active: true },
      { id: 'm2', employeeId: 'admin', businessId: 'dev', unit: 'dev', role: 'owner', active: true },
      { id: 'm3', employeeId: 'staff', businessId: 'padel', unit: 'padel', role: 'staff', active: true },
    ],
    businessOwners: DEFAULT_BUSINESS_OWNERS.map((item) => ({ ...item })),
    employees: [
      { id: 'admin', name: 'Админ', code: '111111', role: 'admin', unit: 'all', active: true },
      { id: 'staff', name: 'Сотрудник', code: '222222', role: 'staff', unit: 'padel', active: true },
    ],
    clients: [], venues: [], players: [], tasks: [], staffExpenses: [], cash: [], files: [], notifications: [], finance: [],
    bankTransactions: [
      { id: 'q1', bankId: 'b1', date: '2026-09-01', type: 'expense', amount: 5000, method: 'card', source: 'bank', counterparty: 'PADEL KLUB', comment: '' },
      { id: 'q2', bankId: 'b2', date: '2026-09-02', type: 'income', amount: 700, method: 'sbp', source: 'bank', counterparty: 'Иванов', comment: '' },
      { id: 'q3', bankId: 'b3', date: '2026-09-03', type: 'expense', amount: 90, method: 'card', source: 'bank', counterparty: 'PADEL KLUB', comment: '', ignored: true },
    ],
  }));
  return makeStore();
}

test('демо: админ создаёт правило, очередь разносится, скрытые и неподходящие остаются', async () => {
  const store = storeWithQueue();
  assert.equal((await store.create('demo:staff', 'bankAutoRules', { match: 'padel', businessId: 'padel', category: 'Аренда' })).ok, false);
  const created = await store.create('demo:admin', 'bankAutoRules', { match: 'padel klub', type: 'expense', businessId: 'padel', category: 'Аренда', owner: 'andrey' });
  assert.equal(created.ok, true);

  const applied = await store.applyBankRules('demo:admin');
  assert.deepEqual({ applied: applied.applied, failed: applied.failed }, { applied: 1, failed: 0 });

  const data = (await store.bootstrap('demo:admin')).data;
  assert.deepEqual(data.bankTransactions.map((item) => item.id).sort(), ['q2', 'q3']);
  const finance = data.finance.find((item) => item.bankId === 'b1');
  assert.equal(finance.businessId, 'padel');
  assert.equal(finance.category, 'Аренда');
  assert.equal(finance.owner, 'andrey');
  assert.equal(finance.ruleId, created.item.id);
  assert.deepEqual((await store.bootstrap('demo:staff')).data.bankAutoRules, []);
});

test('демо: «Не учитывать» скрывает операцию и возвращает её обратно', async () => {
  const store = storeWithQueue();
  assert.equal((await store.ignoreBankTransaction('demo:staff', 'q2')).ok, false);
  assert.equal((await store.ignoreBankTransaction('demo:admin', 'q2', true)).item.ignored, true);
  assert.equal((await store.ignoreBankTransaction('demo:admin', 'q2', false)).item.ignored, false);
});

test('банковская операция после проведения снова редактируется обычной формой', async () => {
  const store = storeWithQueue();
  const processed = await store.processBankTransaction('demo:admin', 'q2', 'dev', 'Прочее');
  assert.equal(processed.ok, true);
  const moved = await store.update('demo:admin', 'finance', { ...processed.item, businessId: 'padel', unit: 'padel', category: 'Оплата клиента' });
  assert.equal(moved.ok, true);
  assert.equal(moved.item.businessId, 'padel');
});

test('сервер: синхронизация не падает целиком и сохраняет безопасную причину ошибки', async () => {
  const [bank, http, migration, deploy] = await Promise.all([
    readFile(new URL('../supabase/functions/api/bank.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/functions/api/http.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/010_remove_bank_rule_engine.sql', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/deploy-backend.yml', import.meta.url), 'utf8'),
  ]);
  assert.match(bank, /saveFailed\+\+/);
  assert.match(bank, /applyBankAutoRules\(\)/);
  assert.match(bank, /safeSyncErrorReason\(error\)/);
  assert.match(http, /case "apply_bank_rules"/);
  assert.match(http, /case "ignore_bank_transaction"/);
  assert.match(migration, /drop trigger if exists bank_rules_protect_records_trigger on public\.records/);
  assert.match(deploy, /010_remove_bank_rule_engine\.sql[\s\S]*010_remove_bank_rule_engine\.sql/);
  assert.doesNotMatch(deploy, /009_bank_rules/);
});
