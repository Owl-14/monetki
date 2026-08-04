import test from 'node:test';
import assert from 'node:assert/strict';

import { makeStore } from '../js/store.js';

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
const adminToken = 'demo:u-admin';

function freshStore() {
  localStorage.clear();
  return makeStore();
}

test('демо CRM пустая и содержит только стандартную конфигурацию продаж', async () => {
  const result = await freshStore().bootstrap(adminToken);

  assert.equal(result.ok, true);
  for (const entity of ['companies', 'contacts', 'leads', 'deals', 'dealItems']) {
    assert.deepEqual(result.data[entity], []);
  }
  assert.deepEqual(result.data.pipelines.map(({ id, businessId, unit, name }) => ({ id, businessId, unit, name })), [{
    id: 'pipeline-dev-default', businessId: 'dev', unit: 'dev', name: 'Новые продажи'
  }]);
  assert.deepEqual(result.data.stages.map(({ id, pipelineId, order, type }) => ({ id, pipelineId, order, type })), [
    { id: 'stage-dev-contact', pipelineId: 'pipeline-dev-default', order: 10, type: 'open' },
    { id: 'stage-dev-talks', pipelineId: 'pipeline-dev-default', order: 20, type: 'open' },
    { id: 'stage-dev-prepayment', pipelineId: 'pipeline-dev-default', order: 30, type: 'open' },
    { id: 'stage-dev-work', pipelineId: 'pipeline-dev-default', order: 40, type: 'open' },
    { id: 'stage-dev-won', pipelineId: 'pipeline-dev-default', order: 50, type: 'won' },
    { id: 'stage-dev-lost', pipelineId: 'pipeline-dev-default', order: 60, type: 'lost' }
  ]);
});

test('legacy clients читаются как переходные компании без миграции и дублей', async () => {
  const store = freshStore();
  await store.bootstrap(adminToken);
  const db = JSON.parse(localStorage.getItem(DB_KEY));
  db.clients.push({
    id: 'old-1', businessId: 'dev', unit: 'dev', name: 'Старый клиент', company: 'ООО «Старое»',
    phone: '+7 900 000-00-00', tg: '@old', status: 'work', amount: 1000, notes: 'Не мигрирован'
  });
  localStorage.setItem(DB_KEY, JSON.stringify(db));

  const first = await store.bootstrap(adminToken);
  const legacy = first.data.companies.find((item) => item.id === 'legacy-client:old-1');
  assert.deepEqual(
    { name: legacy.name, legalName: legacy.legalName, legacyClientId: legacy.legacyClientId, legacy: legacy.legacy, readOnly: legacy.readOnly },
    { name: 'Старый клиент', legalName: 'ООО «Старое»', legacyClientId: 'old-1', legacy: true, readOnly: true }
  );
  assert.equal(first.data.clients.some((item) => item.id === 'old-1'), true);
  assert.equal(JSON.parse(localStorage.getItem(DB_KEY)).companies.some((item) => item.id === legacy.id), false);
  assert.equal((await store.update(adminToken, 'companies', { id: legacy.id, name: 'Нельзя' })).error, 'Переходная запись клиента доступна только для чтения');
  assert.equal((await store.remove(adminToken, 'companies', legacy.id)).error, 'Переходная запись клиента доступна только для чтения');

  const current = JSON.parse(localStorage.getItem(DB_KEY));
  current.companies.push({
    id: 'migrated-1', businessId: 'dev', unit: 'dev', name: 'Перенесённый клиент',
    responsibleIds: [], status: 'work', legacyClientId: 'old-1'
  });
  localStorage.setItem(DB_KEY, JSON.stringify(current));
  const migrated = await store.bootstrap(adminToken);
  assert.equal(migrated.data.companies.filter((item) => item.legacyClientId === 'old-1').length, 1);
  assert.equal(migrated.data.companies.some((item) => item.id === legacy.id), false);
});

test('все CRM-сущности проходят создание, обновление, чтение и удаление', async () => {
  const store = freshStore();
  await store.bootstrap(adminToken);
  const create = async (entity, item) => {
    const result = await store.create(adminToken, entity, { businessId: 'dev', ...item });
    assert.equal(result.ok, true, `${entity}: ${result.error || ''}`);
    assert.equal(result.item.businessId, 'dev');
    assert.equal(result.item.unit, 'dev');
    return result.item;
  };

  const company = await create('companies', { name: 'Компания', responsibleIds: ['u-admin'], status: 'work' });
  const contact = await create('contacts', { companyId: company.id, name: 'Контакт', isPrimary: true });
  const lead = await create('leads', { name: 'Лид', responsibleId: 'u-admin', status: 'working' });
  const pipeline = await create('pipelines', { name: 'Повторные продажи', isDefault: false, active: true });
  const stage = await create('stages', { pipelineId: pipeline.id, name: 'Обсуждение', order: 10, type: 'open' });
  const deal = await create('deals', {
    name: 'Сделка', companyId: company.id, contactId: contact.id, pipelineId: pipeline.id,
    stageId: stage.id, amount: 50000, responsibleId: 'u-admin', plannedCloseDate: '2026-09-01'
  });
  const dealItem = await create('dealItems', { dealId: deal.id, name: 'Разработка', amount: 50000, recurring: false });

  for (const [entity, item] of Object.entries({ companies: company, contacts: contact, leads: lead, pipelines: pipeline, stages: stage, deals: deal, dealItems: dealItem })) {
    const updated = await store.update(adminToken, entity, { id: item.id, name: `${item.name} — обновлено` });
    assert.equal(updated.ok, true, `${entity}: ${updated.error || ''}`);
    assert.match(updated.item.name, /обновлено/);
  }

  const bootstrap = await store.bootstrap(adminToken);
  for (const [entity, item] of Object.entries({ companies: company, contacts: contact, leads: lead, pipelines: pipeline, stages: stage, deals: deal, dealItems: dealItem })) {
    assert.equal(bootstrap.data[entity].some((record) => record.id === item.id), true, entity);
  }

  assert.equal((await store.remove(adminToken, 'companies', company.id)).error, 'Сначала удалите контакты компании');
  for (const [entity, id] of [
    ['dealItems', dealItem.id], ['deals', deal.id], ['contacts', contact.id], ['companies', company.id],
    ['stages', stage.id], ['pipelines', pipeline.id], ['leads', lead.id]
  ]) {
    const removed = await store.remove(adminToken, entity, id);
    assert.equal(removed.ok, true, `${entity}: ${removed.error || ''}`);
  }
});

test('CRM отклоняет чужой бизнес, mismatch, архив и неверные связи', async () => {
  const store = freshStore();
  await store.bootstrap(adminToken);

  const noAccess = await store.create('demo:u-dasha', 'companies', { businessId: 'padel', name: 'Чужая' });
  assert.equal(noAccess.error, 'Нет доступа к этому бизнесу');
  const mismatch = await store.create(adminToken, 'companies', { businessId: 'dev', unit: 'padel', name: 'Смешанная' });
  assert.equal(mismatch.error, 'businessId и unit должны совпадать');

  const company = await store.create(adminToken, 'companies', { businessId: 'dev', name: 'Dev-компания' });
  assert.equal(company.ok, true);
  const crossBusiness = await store.create(adminToken, 'contacts', {
    businessId: 'padel', companyId: company.item.id, name: 'Чужой контакт'
  });
  assert.equal(crossBusiness.error, 'Компания относится к другому бизнесу');

  const lostDeal = await store.create(adminToken, 'deals', {
    businessId: 'dev', name: 'Отказ без причины', pipelineId: 'pipeline-dev-default',
    stageId: 'stage-dev-lost', amount: 0, responsibleId: 'u-admin'
  });
  assert.equal(lostDeal.error, 'Укажите причину отказа');

  const dev = (await store.bootstrap(adminToken)).data.businesses.find((item) => item.id === 'dev');
  assert.equal((await store.update(adminToken, 'businesses', { ...dev, active: false })).ok, true);
  const archived = await store.create(adminToken, 'leads', { businessId: 'dev', name: 'В архиве' });
  assert.equal(archived.error, 'Бизнес в архиве');
});

