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

const scope = { businessId: 'padel', unit: 'padel' };

test('чистый demo проходит реальный складской цикл без предзаполненных товаров', async () => {
  localStorage.clear();
  const store = makeStore();
  const login = await store.login('222222');
  assert.equal(login.ok, true);
  const token = login.token;

  const initial = await store.bootstrap(token);
  for (const entity of ['warehouses', 'stockItems', 'stockMovements', 'stockBalances', 'reservations', 'inventories']) {
    assert.deepEqual(initial.data[entity], [], entity);
  }

  const firstWarehouse = await store.create(token, 'warehouses', { ...scope, name: 'Основной', active: true });
  const secondWarehouse = await store.create(token, 'warehouses', { ...scope, name: 'События', active: true });
  const stockItem = await store.create(token, 'stockItems', {
    ...scope, name: 'Тестовая позиция', sku: 'SMOKE-1', unitName: 'шт.', costPrice: 125, minStock: 2, active: true,
  });
  assert.equal(firstWarehouse.ok, true);
  assert.equal(secondWarehouse.ok, true);
  assert.equal(stockItem.ok, true);

  const receipt = await store.create(token, 'stockMovements', {
    ...scope,
    type: 'receipt',
    warehouseId: firstWarehouse.item.id,
    stockItemId: stockItem.item.id,
    quantity: 10,
    date: '2026-08-04',
    supplier: 'Поставщик smoke-теста',
    totalAmount: 1250,
  });
  assert.equal(receipt.ok, true);

  const reservation = await store.create(token, 'reservations', {
    ...scope,
    warehouseId: firstWarehouse.item.id,
    stockItemId: stockItem.item.id,
    quantity: 3,
    status: 'active',
    note: 'Резерв smoke-теста',
  });
  assert.equal(reservation.ok, true);

  const overExpense = await store.create(token, 'stockMovements', {
    ...scope,
    type: 'expense',
    warehouseId: firstWarehouse.item.id,
    stockItemId: stockItem.item.id,
    quantity: 8,
    date: '2026-08-04',
  });
  assert.equal(overExpense.ok, false);

  const transfer = await store.create(token, 'stockMovements', {
    ...scope,
    type: 'transfer',
    fromWarehouseId: firstWarehouse.item.id,
    toWarehouseId: secondWarehouse.item.id,
    stockItemId: stockItem.item.id,
    quantity: 4,
    date: '2026-08-04',
  });
  assert.equal(transfer.ok, true);

  let data = (await store.bootstrap(token)).data;
  let firstBalance = data.stockBalances.find((balance) => balance.warehouseId === firstWarehouse.item.id);
  let secondBalance = data.stockBalances.find((balance) => balance.warehouseId === secondWarehouse.item.id);
  assert.deepEqual(
    { quantity: firstBalance.quantity, reserved: firstBalance.reserved },
    { quantity: 6, reserved: 3 },
  );
  assert.deepEqual(
    { quantity: secondBalance.quantity, reserved: secondBalance.reserved },
    { quantity: 4, reserved: 0 },
  );

  const released = await store.update(token, 'reservations', { ...reservation.item, status: 'released' });
  assert.equal(released.ok, true);
  const expense = await store.create(token, 'stockMovements', {
    ...scope,
    type: 'expense',
    warehouseId: firstWarehouse.item.id,
    stockItemId: stockItem.item.id,
    quantity: 2,
    date: '2026-08-04',
  });
  assert.equal(expense.ok, true);

  const inventory = await store.create(token, 'inventories', {
    ...scope,
    warehouseId: firstWarehouse.item.id,
    date: '2026-08-04',
    status: 'draft',
    items: [{ stockItemId: stockItem.item.id, actualQuantity: 7 }],
    note: 'Инвентаризация smoke-теста',
  });
  assert.equal(inventory.ok, true);
  const completed = await store.update(token, 'inventories', { ...inventory.item, status: 'completed' });
  assert.equal(completed.ok, true);

  data = (await store.bootstrap(token)).data;
  firstBalance = data.stockBalances.find((balance) => balance.warehouseId === firstWarehouse.item.id);
  secondBalance = data.stockBalances.find((balance) => balance.warehouseId === secondWarehouse.item.id);
  assert.deepEqual(
    { quantity: firstBalance.quantity, reserved: firstBalance.reserved },
    { quantity: 7, reserved: 0 },
  );
  assert.equal(secondBalance.quantity, 4);
  assert.ok(data.stockMovements.some((movement) => movement.type === 'inventory' && movement.inventoryId === inventory.item.id));

  assert.equal((await store.create(token, 'stockBalances', {
    ...scope,
    warehouseId: firstWarehouse.item.id,
    stockItemId: stockItem.item.id,
    quantity: 100,
    reserved: 0,
  })).ok, false);
  assert.equal((await store.update(token, 'stockMovements', { ...receipt.item, quantity: 100 })).ok, false);
  assert.equal((await store.remove(token, 'stockMovements', receipt.item.id)).ok, false);
  assert.equal((await store.update(token, 'inventories', { ...completed.item, note: 'Подмена' })).ok, false);
  assert.equal((await store.remove(token, 'inventories', completed.item.id)).ok, false);
});
