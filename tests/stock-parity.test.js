import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_BUSINESS_OWNERS, makeStore } from '../js/store.js';
import {
  baseWriteError,
  checkWriteAccess,
  visibleBootstrapData,
} from '../supabase/functions/api/rules.js';
import {
  stockModuleWriteError,
  stockRecordError,
} from '../supabase/functions/api/stock-rules.js';

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
const users = {
  admin: { id: 'admin', name: 'Админ', code: '111111', role: 'admin', unit: 'all', active: true },
  padel: { id: 'padel-user', name: 'Кладовщик', code: '222222', role: 'staff', unit: 'padel', active: true },
  dev: { id: 'dev-user', name: 'Разработчик', code: '333333', role: 'staff', unit: 'dev', active: true },
};

function fixture() {
  const businesses = [
    { id: 'padel', name: 'Падел', modules: ['dashboard', 'stock'], active: true },
    { id: 'dev', name: 'Разработка', modules: ['dashboard'], active: true },
    { id: 'archive', name: 'Архив', modules: ['dashboard', 'stock'], active: false },
  ];
  const memberships = [
    { id: 'm-admin-padel', employeeId: 'admin', businessId: 'padel', unit: 'padel', role: 'owner', active: true },
    { id: 'm-admin-dev', employeeId: 'admin', businessId: 'dev', unit: 'dev', role: 'owner', active: true },
    { id: 'm-admin-archive', employeeId: 'admin', businessId: 'archive', unit: 'archive', role: 'owner', active: true },
    { id: 'm-padel', employeeId: 'padel-user', businessId: 'padel', unit: 'padel', role: 'staff', active: true },
    { id: 'm-dev', employeeId: 'dev-user', businessId: 'dev', unit: 'dev', role: 'staff', active: true },
  ];
  const scoped = (id, businessId, extra = {}) => ({ id, businessId, unit: businessId, ...extra });
  const warehouses = [
    scoped('wh-padel', 'padel', { name: 'Падел', active: true }),
    scoped('wh-dev', 'dev', { name: 'Dev', active: true }),
    scoped('wh-archive', 'archive', { name: 'Архив', active: true }),
  ];
  const stockItems = [
    scoped('item-padel', 'padel', { name: 'Мячи', sku: 'BALL', unitName: 'шт.', costPrice: 100, minStock: 2, active: true }),
    scoped('item-dev', 'dev', { name: 'Кабель', sku: 'CABLE', unitName: 'шт.', costPrice: 50, minStock: 1, active: true }),
    scoped('item-archive', 'archive', { name: 'Архив', sku: 'OLD', unitName: 'шт.', costPrice: 1, minStock: 0, active: true }),
  ];
  return {
    businesses,
    memberships,
    businessOwners: DEFAULT_BUSINESS_OWNERS.map((owner) => ({ ...owner })),
    employees: Object.values(users),
    clients: [], venues: [], players: [], tasks: [], finance: [], staffExpenses: [], cash: [], files: [], notifications: [],
    warehouses,
    stockItems,
    stockMovements: [
      scoped('move-padel', 'padel', { type: 'receipt', warehouseId: 'wh-padel', stockItemId: 'item-padel', quantity: 8 }),
      scoped('move-dev', 'dev', { type: 'receipt', warehouseId: 'wh-dev', stockItemId: 'item-dev', quantity: 5 }),
      scoped('move-archive', 'archive', { type: 'receipt', warehouseId: 'wh-archive', stockItemId: 'item-archive', quantity: 1 }),
    ],
    stockBalances: [
      scoped('balance-padel', 'padel', { warehouseId: 'wh-padel', stockItemId: 'item-padel', quantity: 8, reserved: 2 }),
      scoped('balance-dev', 'dev', { warehouseId: 'wh-dev', stockItemId: 'item-dev', quantity: 5, reserved: 0 }),
      scoped('balance-archive', 'archive', { warehouseId: 'wh-archive', stockItemId: 'item-archive', quantity: 1, reserved: 0 }),
    ],
    reservations: [
      scoped('reserve-padel', 'padel', { warehouseId: 'wh-padel', stockItemId: 'item-padel', quantity: 2, status: 'active' }),
      scoped('reserve-dev', 'dev', { warehouseId: 'wh-dev', stockItemId: 'item-dev', quantity: 1, status: 'active' }),
    ],
    inventories: [
      scoped('inventory-padel', 'padel', { warehouseId: 'wh-padel', status: 'completed', items: [{ stockItemId: 'item-padel', actualQuantity: 8 }] }),
      scoped('inventory-dev', 'dev', { warehouseId: 'wh-dev', status: 'draft', items: [{ stockItemId: 'item-dev', actualQuantity: 5 }] }),
    ],
  };
}

function localStoreWith(data) {
  localStorage.clear();
  localStorage.setItem(DB_KEY, JSON.stringify(data));
  return makeStore();
}

function serverWriteError(user, entity, item, data) {
  return baseWriteError(user, entity)
    || checkWriteAccess(user, entity, item, data.memberships, data.businesses)
    || stockModuleWriteError(data.businesses, item)
    || stockRecordError(entity, item, data);
}

for (const user of Object.values(users)) {
  test(`складской bootstrap LocalStore и Supabase совпадает для ${user.role}/${user.unit}`, async () => {
    const data = fixture();
    const local = await localStoreWith(data).bootstrap(`demo:${user.id}`);
    assert.equal(local.ok, true);

    const server = visibleBootstrapData(user, data, local.data.bankBalance);
    for (const entity of ['warehouses', 'stockItems', 'stockMovements', 'stockBalances', 'reservations', 'inventories']) {
      assert.deepEqual(local.data[entity], server[entity], entity);
    }
  });
}

test('модуль, membership и совпадающий scope одинаково обязательны в обоих хранилищах', async () => {
  const cases = [
    {
      user: users.padel,
      entity: 'warehouses',
      item: { businessId: 'padel', unit: 'padel', name: 'Новый склад', active: true },
      allowed: true,
    },
    {
      user: users.dev,
      entity: 'warehouses',
      item: { businessId: 'dev', unit: 'dev', name: 'Скрытый склад', active: true },
      allowed: false,
    },
    {
      user: users.padel,
      entity: 'warehouses',
      item: { businessId: 'padel', unit: 'dev', name: 'Подмена', active: true },
      allowed: false,
    },
    {
      user: users.dev,
      entity: 'warehouses',
      item: { businessId: 'padel', unit: 'padel', name: 'Чужой склад', active: true },
      allowed: false,
    },
    {
      user: users.admin,
      entity: 'stockBalances',
      item: { businessId: 'padel', unit: 'padel', warehouseId: 'wh-padel', stockItemId: 'item-padel', quantity: 1, reserved: 0 },
      allowed: false,
    },
    {
      user: users.padel,
      entity: 'stockMovements',
      item: { businessId: 'padel', unit: 'padel', type: 'receipt', warehouseId: 'wh-padel', stockItemId: 'item-dev', quantity: 1, date: '2026-08-04' },
      allowed: false,
    },
  ];

  for (const entry of cases) {
    const data = fixture();
    const local = await localStoreWith(data).create(`demo:${entry.user.id}`, entry.entity, entry.item);
    const serverError = serverWriteError(entry.user, entry.entity, entry.item, data);
    assert.equal(local.ok === true, entry.allowed, `${entry.entity}: LocalStore`);
    assert.equal(serverError === null, entry.allowed, `${entry.entity}: Supabase`);
  }
});

test('отключённый membership и архивный бизнес закрывают складские данные', async () => {
  const data = fixture();
  data.memberships.find((membership) => membership.id === 'm-padel').active = false;
  const local = await localStoreWith(data).bootstrap('demo:padel-user');
  const server = visibleBootstrapData(users.padel, data);

  assert.deepEqual(local.data.warehouses, []);
  assert.deepEqual(server.warehouses, []);
  assert.equal(local.data.stockMovements.some((item) => item.businessId === 'archive'), false);
  assert.equal(server.stockMovements.some((item) => item.businessId === 'archive'), false);
});
