import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("сервер делегирует все изменения остатков атомарным RPC", async () => {
  const [stock, actions] = await Promise.all([
    read("../supabase/functions/api/stock.ts"),
    read("../supabase/functions/api/actions.ts"),
  ]);
  for (const rpc of ["stock_apply_movement", "stock_apply_reservation", "stock_complete_inventory", "stock_save_inventory", "stock_delete_catalog"]) {
    assert.match(stock, new RegExp(`stockRpc\\("${rpc}"`));
  }
  assert.doesNotMatch(stock, /writeRows|writeRow\("stockBalances"/);
  assert.match(actions, /entity === "reservations"[\s\S]{0,100}return await applyReservationChange\(null, item\)/);
  assert.match(actions, /entity === "reservations"[\s\S]{0,100}return await applyReservationChange\(before, merged\)/);
  assert.match(actions, /entity === "reservations"[\s\S]{0,100}return await applyReservationChange\(before, null\)/);
  assert.match(actions, /entity === "inventories"[\s\S]{0,160}return await saveInventory\(before, merged\)/);
  assert.match(actions, /entity === "inventories"[\s\S]{0,100}return await saveInventory\(before, null\)/);
  assert.match(actions, /entity === "inventories"[\s\S]{0,100}item\.createdBy = u\.id/);
  assert.match(actions, /entity === "warehouses" \|\| entity === "stockItems"[\s\S]{0,100}return await deleteStockCatalog\(entity, before\)/);
});

test("SQL блокирует остатки и проверяет доступное количество внутри транзакции", async () => {
  const sql = await read("../supabase/migrations/004_atomic_stock_operations.sql");
  for (const fn of ["stock_apply_movement", "stock_apply_reservation", "stock_complete_inventory", "stock_save_inventory", "stock_delete_catalog"]) {
    assert.match(sql, new RegExp(`create or replace function ${fn}`));
  }
  assert.ok((sql.match(/for update/gi) || []).length >= 4, "нет блокировок актуальных строк");
  assert.match(sql, /order by id for update/);
  assert.ok((sql.match(/order by entity, id for update/g) || []).length >= 3,
    "движение, резерв и инвентаризация должны блокировать каталог в одном порядке");
  assert.match(sql, /v_next < v_reserved/);
  assert.match(sql, /v_reserved > v_quantity/);
  assert.match(sql, /v_actual < v_reserved/);
  assert.ok((sql.match(/coalesce\(data->>'businessId', data->>'unit'\) = v_business/g) || []).length >= 5,
    "ссылки должны проверяться внутри одного бизнеса");
});

test("удаление каталога атомарно блокируется любой строкой остатка", async () => {
  const sql = await read("../supabase/migrations/004_atomic_stock_operations.sql");
  const catalog = sql.slice(sql.indexOf("create or replace function stock_delete_catalog"),
    sql.indexOf("create or replace function stock_apply_reservation"));
  assert.match(catalog, /where entity = p_entity and id = v_id for update/);
  assert.match(catalog, /entity = 'stockBalances' and data->>'warehouseId' = v_id/);
  assert.match(catalog, /entity = 'stockBalances' and data->>'stockItemId' = v_id/);
  assert.doesNotMatch(catalog, /stockBalances'[\s\S]{0,160}quantity/);
});

test("повторное завершение инвентаризации идемпотентно и не дублирует движения", async () => {
  const sql = await read("../supabase/migrations/004_atomic_stock_operations.sql");
  const completedCheck = sql.indexOf("v_existing->>'status' = 'completed'");
  const movementInsert = sql.indexOf("'stockMovements', v_movement_id", completedCheck);
  assert.ok(completedCheck >= 0 && movementInsert > completedCheck);
  assert.match(sql, /v_movement_id := 'stock-inventory-' \|\| v_id \|\| '-' \|\| v_item/);
  assert.match(sql.slice(movementInsert), /on conflict \(entity, id\) do nothing/);
  assert.match(sql, /values \('inventories', v_id, p_inventory \|\| jsonb_build_object\('status', 'draft'\)\)/);
  assert.match(sql, /if not p_allow_create then[\s\S]*Инвентаризация не найдена/);
  assert.match(sql, /p_expected is not null and v_existing is distinct from p_expected/);
  assert.match(sql, /stock_save_inventory[\s\S]*v_existing is distinct from p_before/);
});

test("RPC закрыты от клиентских ролей и миграция выполняется до деплоя функции", async () => {
  const [sql, workflow] = await Promise.all([
    read("../supabase/migrations/004_atomic_stock_operations.sql"),
    read("../.github/workflows/deploy-backend.yml"),
  ]);
  assert.ok((sql.match(/revoke all on function/g) || []).length === 5);
  assert.ok((sql.match(/grant execute on function/g) || []).length === 5);
  assert.match(sql, /from public, anon, authenticated/);
  assert.match(sql, /notify pgrst, 'reload schema'/);
  assert.ok(workflow.indexOf("004_atomic_stock_operations.sql") < workflow.indexOf("Deploy api function"));
  assert.match(workflow, /Применить серверные миграции/);
});
