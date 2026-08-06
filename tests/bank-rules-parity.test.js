import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { LocalStore } from '../js/store.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const install = () => {
  const storage = new MemoryStorage();
  globalThis.localStorage = storage;
  globalThis.window = { localStorage: storage, MONETKI_CONFIG: {} };
  return storage;
};

test('браузерный и серверный evaluator являются точными зеркалами', async () => {
  const [browser, server] = await Promise.all([
    readFile(new URL('../js/bank-rules.js', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/functions/api/bank-rules.js', import.meta.url), 'utf8'),
  ]);
  assert.equal(server.replaceAll('\r\n', '\n'), browser.replaceAll('\r\n', '\n'));
});

test('LocalStore скрывает правила, настройки, журнал и очередь от сотрудника', async () => {
  install();
  const store = new LocalStore();
  const adminLogin = await store.login('111111');
  const staffLogin = await store.login('222222');
  const admin = await store.bootstrap(adminLogin.token);
  const staff = await store.bootstrap(staffLogin.token);
  assert.ok(Array.isArray(admin.data.bankRules));
  assert.ok(Array.isArray(admin.data.bankRuleSettings));
  assert.ok(Array.isArray(admin.data.bankRuleSettingVersions));
  assert.deepEqual(staff.data.bankRules, []);
  assert.deepEqual(staff.data.bankRuleSettings, []);
  assert.deepEqual(staff.data.bankRuleSettingVersions, []);
  assert.deepEqual(staff.data.bankRuleApplications, []);
  assert.deepEqual(staff.data.financeRelations, []);
  assert.deepEqual(staff.data.bankTransactions, []);
  assert.equal((await store.bankRulesList(staffLogin.token)).ok, false);
  assert.equal((await store.bankRuleDryRun(staffLogin.token)).ok, false);
  assert.equal((await store.bankRuleJournal(staffLogin.token)).ok, false);
});

test('LocalStore создаёт неизменяемую версию и проверяет expectedVersion', async () => {
  install();
  const store = new LocalStore();
  const { token } = await store.login('111111');
  const draft = {
    name: 'Только предложение', enabled: true, priority: 1, order: 1, decision: 'suggest', stopOnMatch: false,
    conditions: { all: [{ field: 'direction', op: 'exact', value: 'income' }], any: [], none: [] },
    actions: { businessId: 'padel', category: 'Оплата клиента' },
  };
  const first = await store.bankRuleSave(token, draft, 0);
  assert.equal(first.ok, true);
  assert.equal(first.rule.version, 1);
  assert.equal((await store.bankRuleSave(token, { ...first.rule, name: 'Конфликт' }, 0)).ok, false);
  const second = await store.bankRuleSave(token, { ...first.rule, name: 'Версия 2' }, 1);
  assert.equal(second.rule.version, 2);
  const listed = await store.bankRulesList(token);
  assert.equal(listed.rules.length, 1);
  assert.equal(listed.versions.length, 2);
  assert.equal(listed.versions[0].name, 'Только предложение');
  const archived = await store.bankRuleDelete(token, second.rule.id, 2);
  assert.equal(archived.ok, true);
  assert.equal(archived.rule.deleted, true);
  assert.equal(archived.rule.enabled, false);
  assert.equal((await store.bankRulesList(token)).versions.length, 3);
});

test('LocalStore версионирует настройки и не допускает потерянное обновление', async () => {
  install();
  const store = new LocalStore();
  const { token } = await store.login('111111');
  const first = await store.bankRuleSettingsGet(token);
  const updated = await store.bankRuleSettingsUpdate(token, { ...first.settings, maxTransactionsPerRun: 3 }, first.settings.settingsVersion);
  assert.equal(updated.ok, true);
  assert.equal(updated.settings.settingsVersion, first.settings.settingsVersion + 1);
  assert.equal((await store.bankRuleSettingsUpdate(token, updated.settings, first.settings.settingsVersion)).ok, false);
  const bootstrap = await store.bootstrap(token);
  assert.equal(bootstrap.data.bankRuleSettingVersions.length, 2);
  assert.equal(bootstrap.data.bankRuleSettingVersions[0].maxTransactionsPerRun, 10);
});

test('LocalStore generic CRUD не переписывает системные сущности', async () => {
  install();
  const store = new LocalStore();
  const { token } = await store.login('111111');
  for (const entity of ['bankRules', 'bankRuleVersions', 'bankRuleApplications', 'bankRuleRuns', 'bankRuleSettings', 'bankRuleSettingVersions', 'financeRelations']) {
    const result = await store.create(token, entity, { id: `forbidden-${entity}` });
    assert.equal(result.ok, false, entity);
    assert.match(result.error, /отдельным безопасным действием/);
  }
});

test('LocalStore не обходит защиту банковской finance частичным update или delete', async () => {
  const storage = install();
  const store = new LocalStore();
  const { token } = await store.login('111111');
  const db = JSON.parse(storage.getItem('monetki_demo_db'));
  db.finance.push({
    id: 'finance-from-bank', businessId: 'padel', unit: 'padel', source: 'bank', bankId: 'bank-protected',
    type: 'income', amount: 5500, date: '2026-08-06', category: 'Оплата клиента', method: 'account',
  });
  storage.setItem('monetki_demo_db', JSON.stringify(db));
  const updated = await store.update(token, 'finance', { id: 'finance-from-bank', category: 'Прочее' });
  const removed = await store.remove(token, 'finance', 'finance-from-bank');
  assert.equal(updated.ok, false);
  assert.match(updated.error, /специальным действием/);
  assert.equal(removed.ok, false);
  assert.match(removed.error, /безопасной отменой/);
});

test('LocalStore отклоняет backup с несовпадающими банковскими сигналами', async () => {
  install();
  const store = new LocalStore();
  const { token } = await store.login('111111');
  const backup = await store.backup(token);
  backup.data.bankTransactions.push({
    id: 'bad-queue', bankId: 'bad-bank-id', type: 'income', amount: 5500,
    bankSignals: { schemaVersion: 1, direction: 'expense', amountMinor: 550000 },
  });
  const restored = await store.migrateImport(token, backup.data);
  assert.equal(restored.ok, false);
  assert.match(restored.error, /небезопасную банковскую очередь/);
});

test('dry-run LocalStore не изменяет очередь и возвращает только агрегаты', async () => {
  install();
  const store = new LocalStore();
  const { token } = await store.login('111111');
  const before = await store.backup(token);
  const result = await store.bankRuleDryRun(token);
  const after = await store.backup(token);
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes('demo-bank-income'), false);
  assert.equal(after.data.bankTransactions.length, before.data.bankTransactions.length);
  assert.equal(after.data.finance.length, before.data.finance.length);
  assert.equal(after.data.bankRuleRuns.length, before.data.bankRuleRuns.length + 1);
});

test('LocalStore проверяет связи, stale preview, event allocation и idempotency collision', async () => {
  const storage = install();
  const store = new LocalStore();
  const { token } = await store.login('111111');
  const db = JSON.parse(storage.getItem('monetki_demo_db'));
  const transaction = db.bankTransactions.find((item) => item.id === 'bank-demo-income');
  transaction.bankSignals = { schemaVersion: 1, direction: 'income', amountMinor: 4200000 };
  transaction.updated = 123456;
  db.players.push({ id: 'player-padel', businessId: 'padel', unit: 'padel', name: 'Игрок' });
  db.companies.push({ id: 'company-dev', businessId: 'dev', unit: 'dev', name: 'Чужая компания' });
  db.events.push({ id: 'event-padel', businessId: 'padel', unit: 'padel', name: 'Тест', settlementStatus: 'open' });
  db.eventRegistrations.push({
    id: 'registration-padel', businessId: 'padel', unit: 'padel', eventId: 'event-padel',
    participantType: 'player', participantId: 'player-padel', status: 'registered', chargeAmount: 42000,
  });
  storage.setItem('monetki_demo_db', JSON.stringify(db));

  const base = {
    name: 'Безопасная связь', enabled: true, priority: 10, order: 1, decision: 'suggest', stopOnMatch: false,
    conditions: { all: [{ field: 'direction', op: 'exact', value: 'income' }], any: [], none: [] },
    actions: { businessId: 'padel', category: 'Оплата клиента' },
  };
  const foreign = await store.bankRuleSave(token, { ...base, actions: { ...base.actions, links: { companyId: 'company-dev' } } }, 0);
  assert.equal(foreign.ok, false);

  const saved = await store.bankRuleSave(token, {
    ...base,
    actions: {
      ...base.actions,
      links: {
        playerId: 'player-padel',
        event: { eventId: 'event-padel', registrationId: 'registration-padel', purpose: 'payment' },
      },
    },
  }, 0);
  assert.equal(saved.ok, true);
  assert.equal((await store.bankRuleApplySuggestion(token, transaction.id, 'stale', 'apply:test:event:stale')).ok, false);
  const preview = await store.bankRulePreviewTransaction(token, transaction.id);
  assert.equal(preview.ok, true);
  const applied = await store.bankRuleApplySuggestion(token, transaction.id, preview.evaluationToken, 'apply:test:event:1');
  assert.equal(applied.ok, true);
  const replay = await store.bankRuleApplySuggestion(token, transaction.id, '', 'apply:test:event:1');
  assert.equal(replay.alreadyProcessed, true);
  const collision = await store.bankRuleApplySuggestion(token, 'bank-demo-expense', '', 'apply:test:event:1');
  assert.equal(collision.ok, false);
  const after = JSON.parse(storage.getItem('monetki_demo_db'));
  assert.equal(after.eventFinanceAllocations.some((item) => item.financeId === applied.item.id && item.eventId === 'event-padel'), true);
});
