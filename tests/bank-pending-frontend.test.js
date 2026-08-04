import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { DEFAULT_BUSINESSES, DEFAULT_BUSINESS_OWNERS, makeStore } from '../js/store.js';

class MemoryStorage {
  #values = new Map();
  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
  clear() { this.#values.clear(); }
}

globalThis.window = { MONETKI_CONFIG: {} };
globalThis.localStorage = new MemoryStorage();

const DB_KEY = 'monetki_demo_db';

function fixture({ withQueue = true } = {}) {
  const data = {
    businesses: DEFAULT_BUSINESSES.map((item) => ({ ...item, modules: [...item.modules] })),
    memberships: [
      { id: 'm-admin-padel', employeeId: 'admin', businessId: 'padel', unit: 'padel', role: 'owner', active: true },
      { id: 'm-admin-dev', employeeId: 'admin', businessId: 'dev', unit: 'dev', role: 'owner', active: true },
      { id: 'm-staff-padel', employeeId: 'staff', businessId: 'padel', unit: 'padel', role: 'staff', active: true }
    ],
    businessOwners: DEFAULT_BUSINESS_OWNERS.map((item) => ({ ...item })),
    employees: [
      { id: 'admin', name: 'Админ', code: '111111', role: 'admin', unit: 'all', active: true },
      { id: 'staff', name: 'Сотрудник', code: '222222', role: 'staff', unit: 'padel', active: true }
    ],
    clients: [], venues: [], players: [], tasks: [], staffExpenses: [], cash: [], files: [], notifications: [],
    finance: [
      { id: 'legacy-bank-finance', businessId: 'dev', unit: 'dev', date: '2026-08-01', type: 'income', amount: 1000, source: 'bank', category: 'Прочее', bankId: 'legacy-bank-id' }
    ]
  };
  if (withQueue) {
    data.bankTransactions = [
      { id: 'queue-1', bankId: 'new-bank-id', date: '2026-08-02', type: 'expense', amount: 250, method: 'card', source: 'bank', counterparty: 'Поставщик', comment: 'Назначение', created: 1, updated: 1 }
    ];
  }
  return data;
}

function storeWith(data) {
  localStorage.clear();
  localStorage.setItem(DB_KEY, JSON.stringify(data));
  return makeStore();
}

test('LocalStore мягко добавляет пустую очередь, не переписывая старые finance и bankId', async () => {
  const store = storeWith(fixture({ withQueue: false }));
  const result = await store.bootstrap('demo:admin');

  assert.deepEqual(result.data.bankTransactions, []);
  assert.equal(result.data.finance.length, 1);
  assert.equal(result.data.finance[0].id, 'legacy-bank-finance');
  assert.equal(result.data.finance[0].bankId, 'legacy-bank-id');
});

test('необработанные банковские операции доступны только администратору', async () => {
  const store = storeWith(fixture());

  const admin = (await store.bootstrap('demo:admin')).data;
  const staff = (await store.bootstrap('demo:staff')).data;
  assert.equal(admin.bankTransactions.length, 1);
  assert.equal(admin.bankDiagnostics.queue.count, 1);
  assert.deepEqual(staff.bankTransactions, []);
  assert.equal(staff.bankDiagnostics, null);
  assert.equal((await store.processBankTransaction('demo:staff', 'queue-1', 'padel', 'Прочее')).ok, false);
  const genericError = 'Банковскую операцию можно только провести';
  assert.equal((await store.create('demo:admin', 'bankTransactions', {})).error, genericError);
  assert.equal((await store.update('demo:admin', 'bankTransactions', { id: 'queue-1' })).error, genericError);
  assert.equal((await store.remove('demo:admin', 'bankTransactions', 'queue-1')).error, genericError);
});

test('bootstrap показывает безопасную диагностику скрытых банковских областей', async () => {
  const data = fixture();
  data.finance.push(
    { id: 'hidden-all', businessId: 'all', unit: 'all', date: '2026-07-22', source: 'bank', amount: 10, bankId: 'hidden-all' },
    { id: 'hidden-ghost', businessId: 'ghost', unit: 'ghost', date: '2026-08-04', source: 'bank', amount: 20, bankId: 'hidden-ghost' },
  );
  const result = (await storeWith(data).bootstrap('demo:admin')).data;

  assert.equal(result.finance.some((item) => item.id === 'hidden-all' || item.id === 'hidden-ghost'), false);
  assert.deepEqual(result.bankDiagnostics.hiddenInvalidScope, {
    count: 2,
    earliestDate: '2026-07-22',
    latestDate: '2026-08-04'
  });
  assert.deepEqual(result.bankDiagnostics.hiddenInvalidScopeWithoutBankId, {
    count: 0,
    earliestDate: null,
    latestDate: null
  });
  assert.equal(JSON.stringify(result.bankDiagnostics).includes('hidden-all'), false);
  assert.equal(JSON.stringify(result.bankDiagnostics).includes('amount'), false);
});

test('проведение атомарно переносит запись в finance с выбранным бизнесом и категорией', async () => {
  const store = storeWith(fixture());
  const result = await store.processBankTransaction('demo:admin', 'queue-1', 'padel', '  Инвентарь  ');

  assert.equal(result.ok, true);
  assert.equal(result.item.id, 'bank:queue-1');
  assert.equal(result.item.businessId, 'padel');
  assert.equal(result.item.unit, 'padel');
  assert.equal(result.item.category, 'Инвентарь');
  assert.equal(result.item.bankId, 'new-bank-id');
  assert.equal(result.item.bankQueueId, 'queue-1');
  assert.equal(result.item.source, 'bank');

  // Возвращённый объект не является живой ссылкой на сохранённую базу.
  result.item.amount = 999999;

  const data = (await store.bootstrap('demo:admin')).data;
  assert.deepEqual(data.bankTransactions, []);
  assert.equal(data.finance.filter((item) => item.bankId === 'new-bank-id').length, 1);
  assert.equal(data.finance.find((item) => item.bankId === 'new-bank-id').amount, 250);
  const retry = await store.processBankTransaction('demo:admin', 'queue-1', 'padel', 'Инвентарь');
  assert.equal(retry.ok, true);
  assert.equal(retry.alreadyProcessed, true);
  assert.equal(retry.item.id, 'bank:queue-1');
  assert.equal((await store.bootstrap('demo:admin')).data.finance.filter((item) => item.bankId === 'new-bank-id').length, 1);
});

test('существующий finance.bankId очищает очередь без финансового дубля', async () => {
  const data = fixture();
  data.bankTransactions[0].bankId = 'legacy-bank-id';
  const store = storeWith(data);
  const result = await store.processBankTransaction('demo:admin', 'queue-1', 'padel', 'Прочее');

  assert.equal(result.ok, true);
  assert.equal(result.item.id, 'legacy-bank-finance');
  const after = (await store.bootstrap('demo:admin')).data;
  assert.equal(after.finance.length, 1);
  assert.deepEqual(after.bankTransactions, []);
});

test('архивный бизнес и неверная категория не меняют очередь и finance', async () => {
  const data = fixture();
  data.businesses.find((item) => item.id === 'padel').active = false;
  const store = storeWith(data);

  assert.equal((await store.processBankTransaction('demo:admin', 'queue-1', 'padel', 'Прочее')).error, 'Бизнес в архиве');
  assert.equal((await store.processBankTransaction('demo:admin', 'queue-1', 'dev', '')).error, 'Не указана категория');
  assert.equal((await store.processBankTransaction('demo:admin', 'queue-1', 'dev', 'x'.repeat(121))).error, 'Не указана категория');

  const after = (await store.bootstrap('demo:admin')).data;
  assert.equal(after.bankTransactions.length, 1);
  assert.equal(after.finance.length, 1);
});

test('UI очереди не вставляет банковские идентификаторы в DOM и требует назначение', async () => {
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('function renderFinBank(');
  const end = app.indexOf('function renderFinOps(', start);
  const source = app.slice(start, end);

  assert.match(source, /Необработанные|Очередь до назначения бизнеса/);
  assert.match(source, /Все бизнесы/);
  assert.match(source, /всё время/);
  assert.match(source, /name="businessId" required/);
  assert.match(source, /name="category" required/);
  assert.match(source, /processBankTransaction/);
  assert.match(source, /data-bank-diagnostics/);
  assert.match(source, /data-queue-count/);
  assert.match(source, /data-hidden-count/);
  assert.match(source, /data-blocked-count/);
  assert.doesNotMatch(source, /transaction\.bankId|transaction\.accountId/);
  assert.doesNotMatch(source, /data-[^=]+="\$\{[^}]*\.(?:bankId|accountId)/);
});
