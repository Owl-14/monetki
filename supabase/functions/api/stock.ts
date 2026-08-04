import { stockRecordError } from "./stock-rules.js";
import { callRpc, readAll } from "./db/repositories.ts";
import type { Rec } from "./types.ts";

export async function readStockData() {
  const [warehouses, stockItems, stockMovements, stockBalances, reservations, inventories, finance] = await Promise.all([
    readAll("warehouses"), readAll("stockItems"), readAll("stockMovements"), readAll("stockBalances"),
    readAll("reservations"), readAll("inventories"), readAll("finance"),
  ]);
  return { warehouses, stockItems, stockMovements, stockBalances, reservations, inventories, finance };
}

async function stockRpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await callRpc(name, args);
  if (error) return { ok: false, error: error.message || "Не удалось выполнить складскую операцию" };
  if (!data || typeof data !== "object") return { ok: false, error: "Сервер не вернул результат складской операции" };
  return data as { ok: boolean; error?: string; item?: Rec };
}

export async function createStockMovement(item: Rec) {
  const data = await readStockData();
  const validationError = stockRecordError("stockMovements", item, data);
  if (validationError) return { ok: false, error: validationError };
  return await stockRpc("stock_apply_movement", { p_item: item });
}

export async function applyReservationChange(before: Rec | null, after: Rec | null) {
  const data = await readStockData();
  if (after) {
    const validationError = stockRecordError("reservations", after, data, String(before?.id || ""));
    if (validationError) return { ok: false, error: validationError };
  }
  if (before && after && (before.warehouseId !== after.warehouseId || before.stockItemId !== after.stockItemId)) {
    return { ok: false, error: "Нельзя перенести резерв на другой склад или позицию" };
  }
  return await stockRpc("stock_apply_reservation", { p_before: before, p_after: after });
}

export async function completeInventory(inventory: Rec, allowCreate = false) {
  const data = await readStockData();
  const validationError = stockRecordError("inventories", inventory, data, String(inventory.id || ""));
  if (validationError) return { ok: false, error: validationError };
  return await stockRpc("stock_complete_inventory", { p_inventory: inventory, p_allow_create: allowCreate });
}

export async function deleteStockCatalog(entity: string, item: Rec) {
  return await stockRpc("stock_delete_catalog", { p_entity: entity, p_item: item });
}
