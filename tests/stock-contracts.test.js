import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  BUSINESS_MODULES,
  DEFAULT_BUSINESSES as LOCAL_DEFAULT_BUSINESSES,
} from '../js/store.js';
import { normalizeItemScope } from '../js/app-state.js';
import { NAV_ICONS, PAGE_META, pickBottomNavItems } from '../js/app-shell.js';
import {
  BUSINESS_SCOPED_ENTITIES,
  DEFAULT_BUSINESSES as SERVER_DEFAULT_BUSINESSES,
  ENTITIES,
  STOCK_ENTITIES,
} from '../supabase/functions/api/rules.js';
import {
  inventoryAdjustments,
  reservationQuantity,
  stockAvailabilityError,
  stockMovementDeltas,
} from '../supabase/functions/api/stock-rules.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const STOCK_ENTITY_NAMES = [
  'warehouses', 'stockItems', 'stockMovements', 'stockBalances', 'reservations', 'inventories',
];

test('LocalStore и сервер объявляют одинаковый набор складских сущностей', () => {
  assert.deepEqual(STOCK_ENTITIES, STOCK_ENTITY_NAMES);
  for (const entity of STOCK_ENTITY_NAMES) {
    assert.ok(ENTITIES.includes(entity), entity);
    assert.ok(BUSINESS_SCOPED_ENTITIES.includes(entity), entity);
    assert.deepEqual(
      normalizeItemScope(entity, { unit: 'padel' }),
      { businessId: 'padel', unit: 'padel' },
      entity,
    );
  }
});

test('модуль «Склад» включён для Падела и одинаково настроен локально и на сервере', () => {
  assert.equal(BUSINESS_MODULES.stock, 'Склад');
  for (const businesses of [LOCAL_DEFAULT_BUSINESSES, SERVER_DEFAULT_BUSINESSES]) {
    assert.ok(businesses.find((business) => business.id === 'padel').modules.includes('stock'));
    assert.equal(businesses.find((business) => business.id === 'dev').modules.includes('stock'), false);
  }
});

test('оболочка регистрирует склад для desktop и mobile навигации', () => {
  assert.equal(PAGE_META.stock.group, 'Операции');
  assert.ok(PAGE_META.stock.subtitle);
  assert.match(NAV_ICONS.stock, /^<svg /);
  assert.match(NAV_ICONS.stock, /aria-hidden="true"/);

  const items = ['dashboard', 'tasks', 'stock', 'venues', 'finance', 'settings']
    .map((route) => ({ r: route, label: route }));
  assert.deepEqual(
    pickBottomNavItems(items, true).map((item) => item.r),
    ['dashboard', 'tasks', 'finance', 'stock', 'settings'],
  );
});

test('раздел склада сохраняет маршруты, вкладки и реальные пользовательские действия', async () => {
  const app = await read('../js/app.js');

  assert.match(app, /hasModule\('stock'\)/);
  assert.match(app, /stock:\s*viewStock/);
  for (const name of ['viewStock', 'openWarehouseForm', 'openStockItemForm', 'openStockMovementForm', 'openInventoryForm']) {
    assert.match(app, new RegExp(`function ${name}\\(`), name);
  }
  assert.match(app, /const STOCK_TABS\s*=\s*\[/);
  for (const [tab, label] of [
    ['catalog', 'Каталог'], ['balances', 'Остатки'], ['movements', 'Движения'], ['inventories', 'Инвентаризации'],
  ]) {
    assert.match(app, new RegExp(`['"]${tab}['"]\\s*,\\s*['"]${label}['"]`), tab);
  }
  assert.match(app, /data-stock-tab=/);
  for (const id of [
    'stock-tabs', 'add-stock-item', 'add-warehouse', 'stock-receipt',
    'stock-expense', 'stock-transfer', 'stock-inventory',
  ]) {
    assert.match(app, new RegExp(`id=["']${id}["']`), id);
  }
  for (const marker of ['data-stock-item', 'data-warehouse', 'data-inventory']) {
    assert.match(app, new RegExp(marker), marker);
  }
});

test('демо-база не подменяет пользовательский склад фальшивыми остатками', async () => {
  const store = await read('../js/store.js');
  const seed = store.slice(store.indexOf('function seedData()'), store.indexOf('// ---------- LocalStore'));

  for (const entity of STOCK_ENTITY_NAMES) {
    assert.match(seed, new RegExp(`${entity}:\\s*\\[\\]`), entity);
  }
  assert.doesNotMatch(seed, /Комплект медалей|Кубок|Сертификат/);
});

test('чистые складские правила считают движения, инвентаризацию и доступный остаток', () => {
  assert.deepEqual(stockMovementDeltas({ type: 'receipt', warehouseId: 'a', quantity: 8 }), [
    { warehouseId: 'a', delta: 8 },
  ]);
  assert.deepEqual(stockMovementDeltas({ type: 'expense', warehouseId: 'a', quantity: 3 }), [
    { warehouseId: 'a', delta: -3 },
  ]);
  assert.deepEqual(stockMovementDeltas({ type: 'transfer', fromWarehouseId: 'a', toWarehouseId: 'b', quantity: 2 }), [
    { warehouseId: 'a', delta: -2 },
    { warehouseId: 'b', delta: 2 },
  ]);
  assert.deepEqual(
    inventoryAdjustments(
      { warehouseId: 'a', items: [{ stockItemId: 'item', actualQuantity: 11 }] },
      [{ warehouseId: 'a', stockItemId: 'item', quantity: 8 }],
    ),
    [{ stockItemId: 'item', previousQuantity: 8, actualQuantity: 11, delta: 3 }],
  );
  assert.equal(reservationQuantity({ status: 'active', quantity: 4 }), 4);
  assert.equal(reservationQuantity({ status: 'released', quantity: 4 }), 0);
  assert.ok(stockAvailabilityError(
    { type: 'expense', warehouseId: 'a', stockItemId: 'item', quantity: 6 },
    [{ warehouseId: 'a', stockItemId: 'item', quantity: 8, reserved: 3 }],
  ));
});

test('серверные действия используют складские правила и загружают все шесть коллекций', async () => {
  const [actions, stock, stockRules] = await Promise.all([
    read('../supabase/functions/api/actions.ts'),
    read('../supabase/functions/api/stock.ts'),
    read('../supabase/functions/api/stock-rules.js'),
  ]);
  const backend = `${actions}\n${stock}\n${stockRules}`;

  for (const marker of [
    'stockModuleWriteError', 'stockRecordError', 'stockAvailabilityError',
    'stockMovementDeltas', 'inventoryAdjustments', 'reservationQuantity',
  ]) {
    assert.match(backend, new RegExp(marker), marker);
  }
  assert.match(actions, /Promise\.all\(ENTITIES\.map/);
  assert.match(actions, /Object\.fromEntries\(entries\)/);
  assert.match(actions, /visibleBootstrapData\(/);
  assert.match(actions, /(?:Проведённые движения|Движения склада) нельзя (?:изменять|удалять)/);
  assert.match(actions, /Завершённую инвентаризацию нельзя (?:изменять|удалять)/);
});
