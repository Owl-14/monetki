import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  BUSINESS_SCOPED_ENTITIES,
  DEFAULT_BUSINESSES,
  ENTITIES,
  STOCK_ENTITIES,
  baseWriteError,
  visibleBootstrapData,
} from "../supabase/functions/api/rules.js";
import {
  inventoryAdjustments,
  reservationQuantity,
  stockAvailabilityError,
  stockModuleWriteError,
  stockMovementDeltas,
  stockRecordError,
} from "../supabase/functions/api/stock-rules.js";

const user = { id: "staff", name: "Сотрудник", role: "staff", unit: "padel", active: true };

function stockFixture() {
  return {
    businesses: [
      { id: "padel", name: "Падел", modules: ["stock"], active: true },
      { id: "dev", name: "Разработка", modules: ["stock"], active: true },
      { id: "events", name: "События", modules: [], active: true },
    ],
    memberships: [
      { id: "m1", employeeId: "staff", businessId: "padel", unit: "padel", role: "staff", active: true },
    ],
    businessOwners: [],
    employees: [user],
    clients: [], venues: [], players: [], tasks: [], finance: [], staffExpenses: [], cash: [], notifications: [],
    warehouses: [
      { id: "warehouse-padel", businessId: "padel", unit: "padel", name: "Основной", active: true },
      { id: "warehouse-padel-2", businessId: "padel", unit: "padel", name: "Запасной", active: true },
      { id: "warehouse-dev", businessId: "dev", unit: "dev", name: "Dev", active: true },
    ],
    stockItems: [
      { id: "item-padel", businessId: "padel", unit: "padel", name: "Медали", unitName: "комплект", costPrice: 1000, minStock: 2, active: true },
      { id: "item-dev", businessId: "dev", unit: "dev", name: "Сервер", unitName: "шт.", costPrice: 1, minStock: 0, active: true },
    ],
    stockMovements: [],
    stockBalances: [
      { id: "balance", businessId: "padel", unit: "padel", warehouseId: "warehouse-padel", stockItemId: "item-padel", quantity: 10, reserved: 3 },
    ],
    reservations: [],
    inventories: [],
    finance: [
      { id: "finance-padel", businessId: "padel", unit: "padel", type: "expense" },
      { id: "finance-dev", businessId: "dev", unit: "dev", type: "expense" },
    ],
  };
}

test("все сущности склада входят в API и считаются бизнес-данными", () => {
  assert.deepEqual(STOCK_ENTITIES, [
    "warehouses", "stockItems", "stockMovements", "stockBalances", "reservations", "inventories",
  ]);
  for (const entity of STOCK_ENTITIES) {
    assert.equal(ENTITIES.includes(entity), true, entity);
    assert.equal(BUSINESS_SCOPED_ENTITIES.includes(entity), true, entity);
  }
  assert.equal(DEFAULT_BUSINESSES.find((business) => business.id === "padel").modules.includes("stock"), true);
  assert.equal(DEFAULT_BUSINESSES.find((business) => business.id === "dev").modules.includes("stock"), false);
});

test("bootstrap отдаёт склад только по активному membership и включённому модулю", () => {
  const data = stockFixture();
  data.stockItems.push(
    { id: "mismatch", businessId: "padel", unit: "dev", active: true },
    { id: "module-off", businessId: "events", unit: "events", active: true },
  );
  const visible = visibleBootstrapData(user, data);

  assert.deepEqual(visible.warehouses.map((item) => item.id), ["warehouse-padel", "warehouse-padel-2"]);
  assert.deepEqual(visible.stockItems.map((item) => item.id), ["item-padel"]);
  assert.deepEqual(visible.stockBalances.map((item) => item.id), ["balance"]);
});

test("запись склада требует активного бизнеса с модулем stock", () => {
  const data = stockFixture();
  assert.equal(stockModuleWriteError(data.businesses, { businessId: "padel", unit: "padel" }), null);
  assert.equal(stockModuleWriteError(data.businesses, { businessId: "events", unit: "events" }), "Модуль «Склад» отключён");
  data.businesses.find((business) => business.id === "padel").active = false;
  assert.equal(stockModuleWriteError(data.businesses, { businessId: "padel", unit: "padel" }), "Бизнес в архиве");
  assert.equal(baseWriteError(user, "stockBalances"), "Остатки изменяются только складскими операциями");
});

test("валидация справочника и ссылок не допускает чужой бизнес", () => {
  const data = stockFixture();
  const base = { businessId: "padel", unit: "padel", stockItemId: "item-padel", quantity: 2 };
  assert.equal(stockRecordError("stockMovements", { ...base, type: "receipt", warehouseId: "warehouse-padel" }, data), null);
  assert.equal(stockRecordError("stockMovements", {
    ...base, type: "receipt", warehouseId: "warehouse-padel", financeId: "finance-padel", supplier: "Поставщик", totalAmount: 2000,
  }, data), null);
  assert.equal(
    stockRecordError("stockMovements", { ...base, type: "receipt", warehouseId: "warehouse-padel", financeId: "finance-dev" }, data),
    "Финансовая операция не найдена в этом бизнесе",
  );
  assert.equal(
    stockRecordError("stockMovements", { ...base, type: "receipt", warehouseId: "warehouse-dev" }, data),
    "Склад не найден в этом бизнесе",
  );
  assert.equal(
    stockRecordError("stockMovements", { ...base, unit: "dev", type: "receipt", warehouseId: "warehouse-padel" }, data),
    "businessId и unit должны совпадать",
  );
  assert.equal(
    stockRecordError("stockMovements", { ...base, type: "transfer", fromWarehouseId: "warehouse-padel", toWarehouseId: "warehouse-padel" }, data),
    "Для перемещения нужны два разных склада",
  );
  assert.equal(
    stockRecordError("stockMovements", { ...base, type: "unknown", warehouseId: "warehouse-padel" }, data),
    "Неизвестный тип движения",
  );
  assert.equal(
    stockRecordError("stockItems", { businessId: "padel", unit: "padel", name: "Кубок", unitName: "шт.", costPrice: -1, minStock: 0, active: true }, data),
    "Себестоимость должна быть неотрицательным числом",
  );
});

test("приход, расход, перемещение и корректировка дают точные дельты", () => {
  assert.deepEqual(stockMovementDeltas({ type: "receipt", warehouseId: "a", quantity: 5 }), [{ warehouseId: "a", delta: 5 }]);
  assert.deepEqual(stockMovementDeltas({ type: "expense", warehouseId: "a", quantity: 5 }), [{ warehouseId: "a", delta: -5 }]);
  assert.deepEqual(stockMovementDeltas({ type: "transfer", fromWarehouseId: "a", toWarehouseId: "b", quantity: 5 }), [
    { warehouseId: "a", delta: -5 }, { warehouseId: "b", delta: 5 },
  ]);
  assert.deepEqual(stockMovementDeltas({ type: "inventory", direction: "decrease", warehouseId: "a", quantity: 2 }), [
    { warehouseId: "a", delta: -2 },
  ]);
});

test("расход и перемещение не могут затронуть зарезервированный остаток", () => {
  const balances = stockFixture().stockBalances;
  const movement = {
    businessId: "padel", unit: "padel", type: "expense",
    warehouseId: "warehouse-padel", stockItemId: "item-padel", quantity: 7,
  };
  assert.equal(stockAvailabilityError(movement, balances), null);
  assert.equal(
    stockAvailabilityError({ ...movement, quantity: 8 }, balances),
    "Недостаточно свободного остатка: часть товара зарезервирована",
  );
});

test("инвентаризация считает разницу, а резерв учитывает только active", () => {
  const data = stockFixture();
  assert.deepEqual(inventoryAdjustments({
    businessId: "padel", unit: "padel",
    warehouseId: "warehouse-padel",
    items: [{ stockItemId: "item-padel", actualQuantity: 6 }, { stockItemId: "new", actualQuantity: 2 }],
  }, data.stockBalances), [
    { stockItemId: "item-padel", previousQuantity: 10, actualQuantity: 6, delta: -4 },
    { stockItemId: "new", previousQuantity: 0, actualQuantity: 2, delta: 2 },
  ]);
  assert.equal(reservationQuantity({ status: "active", quantity: 3 }), 3);
  assert.equal(reservationQuantity({ status: "released", quantity: 3 }), 0);
});

test("сервер применяет складские операции только через доменный модуль", async () => {
  const actions = await readFile(new URL("../supabase/functions/api/actions.ts", import.meta.url), "utf8");
  const stock = await readFile(new URL("../supabase/functions/api/stock.ts", import.meta.url), "utf8");

  assert.match(actions, /entity === "stockMovements"[\s\S]*createStockMovement\(item\)/);
  assert.match(actions, /Корректировка создаётся только завершением инвентаризации/);
  assert.match(actions, /entity === "reservations"[\s\S]*applyReservationChange\(null, item\)/);
  assert.match(actions, /entity === "inventories"[\s\S]*item\.status === "completed"[\s\S]*completeInventory\(item, true\)/);
  assert.match(actions, /Движения склада нельзя изменять/);
  assert.match(actions, /Движения склада нельзя удалять/);
  assert.match(stock, /stockRpc\("stock_apply_movement", \{ p_item: item \}\)/);
  assert.match(stock, /stockRpc\("stock_apply_reservation", \{ p_before: before, p_after: after \}\)/);
  assert.match(stock, /stockRpc\("stock_complete_inventory", \{ p_inventory: inventory, p_allow_create: allowCreate \}\)/);
  assert.match(stock, /stockRpc\("stock_delete_catalog", \{ p_entity: entity, p_item: item \}\)/);
  assert.doesNotMatch(stock, /writeRows|writeRow\("stockBalances"/);
});
