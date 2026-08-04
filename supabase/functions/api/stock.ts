import {
  inventoryAdjustments,
  reservationQuantity,
  stockAvailabilityError,
  stockBalanceKey,
  stockMovementDeltas,
  stockRecordError,
} from "./stock-rules.js";
import { businessIdOf } from "./rules.js";
import { readAll, writeRow, writeRows } from "./db/repositories.ts";
import { newId } from "./types.ts";
import type { Rec } from "./types.ts";

export async function readStockData() {
  const [warehouses, stockItems, stockMovements, stockBalances, reservations, inventories, finance] = await Promise.all([
    readAll("warehouses"), readAll("stockItems"), readAll("stockMovements"), readAll("stockBalances"),
    readAll("reservations"), readAll("inventories"), readAll("finance"),
  ]);
  return { warehouses, stockItems, stockMovements, stockBalances, reservations, inventories, finance };
}

function balanceFor(data: Awaited<ReturnType<typeof readStockData>>, item: Rec, warehouseId: unknown) {
  const found = data.stockBalances.find((balance) =>
    businessIdOf(balance) === businessIdOf(item) &&
    balance.warehouseId === warehouseId && balance.stockItemId === item.stockItemId
  );
  if (found) return { ...found } as Rec;
  return {
    id: `stock-balance-${stockBalanceKey(warehouseId, item.stockItemId)}`,
    businessId: item.businessId,
    unit: item.unit,
    warehouseId,
    stockItemId: item.stockItemId,
    quantity: 0,
    reserved: 0,
    created: Date.now(),
  } as Rec;
}

export async function createStockMovement(item: Rec) {
  const data = await readStockData();
  const validationError = stockRecordError("stockMovements", item, data);
  if (validationError) return { ok: false, error: validationError };
  const availabilityError = stockAvailabilityError(item, data.stockBalances);
  if (availabilityError) return { ok: false, error: availabilityError };

  const updatedBalances: Rec[] = [];
  for (const change of stockMovementDeltas(item)) {
    const balance = balanceFor(data, item, change.warehouseId);
    balance.quantity = Number(balance.quantity || 0) + change.delta;
    balance.updated = Date.now();
    updatedBalances.push(balance);
  }

  await writeRows([
    { entity: "stockMovements", item },
    ...updatedBalances.map((balance) => ({ entity: "stockBalances", item: balance })),
  ]);
  return { ok: true, item };
}

export async function applyReservationChange(before: Rec | null, after: Rec | null) {
  const item = (after || before) as Rec;
  const data = await readStockData();
  if (after) {
    const validationError = stockRecordError("reservations", after, data, String(before?.id || ""));
    if (validationError) return { ok: false, error: validationError };
  }
  const warehouseId = after?.warehouseId || before?.warehouseId;
  const stockItemId = after?.stockItemId || before?.stockItemId;
  if (before && after && (before.warehouseId !== after.warehouseId || before.stockItemId !== after.stockItemId)) {
    return { ok: false, error: "Нельзя перенести резерв на другой склад или позицию" };
  }
  item.stockItemId = stockItemId;
  const balance = balanceFor(data, item, warehouseId);
  const reserved = Number(balance.reserved || 0) - reservationQuantity(before) + reservationQuantity(after);
  if (reserved < 0) return { ok: false, error: "Резерв уже освобождён" };
  if (reserved > Number(balance.quantity || 0)) return { ok: false, error: "Недостаточно свободного остатка" };
  balance.reserved = reserved;
  balance.updated = Date.now();
  await writeRow("stockBalances", balance);
  return { ok: true };
}

export async function completeInventory(inventory: Rec) {
  const data = await readStockData();
  const validationError = stockRecordError("inventories", inventory, data, String(inventory.id || ""));
  if (validationError) return { ok: false, error: validationError };
  const adjustments = inventoryAdjustments(inventory, data.stockBalances);
  for (const adjustment of adjustments) {
    const balance = data.stockBalances.find((record) =>
      businessIdOf(record) === businessIdOf(inventory) &&
      record.warehouseId === inventory.warehouseId && record.stockItemId === adjustment.stockItemId
    );
    if (adjustment.actualQuantity < Number(balance?.reserved || 0)) {
      return { ok: false, error: "Фактический остаток не может быть меньше резерва" };
    }
  }

  const now = Date.now();
  const completed = { ...inventory, status: "completed", completedAt: now, updated: now } as Rec;
  const rows: Array<{ entity: string; item: Rec }> = [];
  for (const adjustment of adjustments) {
    const balance = balanceFor(data, { ...inventory, stockItemId: adjustment.stockItemId } as Rec, inventory.warehouseId);
    balance.quantity = adjustment.actualQuantity;
    balance.updated = now;
    if (adjustment.delta !== 0) {
      rows.push({ entity: "stockMovements", item: {
        id: newId(), businessId: inventory.businessId, unit: inventory.unit,
        type: "inventory", inventoryId: inventory.id, warehouseId: inventory.warehouseId,
        stockItemId: adjustment.stockItemId, quantity: Math.abs(adjustment.delta),
        direction: adjustment.delta > 0 ? "increase" : "decrease",
        previousQuantity: adjustment.previousQuantity, actualQuantity: adjustment.actualQuantity,
        date: inventory.date || new Date().toISOString().slice(0, 10), note: inventory.note || "",
        created: now, updated: now,
      } as Rec });
    }
    rows.push({ entity: "stockBalances", item: balance });
  }
  rows.push({ entity: "inventories", item: completed });
  await writeRows(rows);
  return { ok: true, item: completed };
}

export function stockCatalogDeleteError(entity: string, item: Rec, data: Awaited<ReturnType<typeof readStockData>>) {
  if (entity !== "warehouses" && entity !== "stockItems") return null;
  const referenceField = entity === "warehouses" ? "warehouseId" : "stockItemId";
  const transferFields = entity === "warehouses" ? ["fromWarehouseId", "toWarehouseId"] : [];
  const hasReference = [data.stockMovements, data.reservations, data.inventories].some((records) =>
    records.some((record) => businessIdOf(record) === businessIdOf(item) &&
      (record[referenceField] === item.id || transferFields.some((field) => record[field] === item.id) ||
      (entity === "stockItems" && Array.isArray(record.items) && record.items.some((line: Rec) => line.stockItemId === item.id))))
  );
  const hasBalance = data.stockBalances.some((balance) =>
    businessIdOf(balance) === businessIdOf(item) && balance[referenceField] === item.id &&
    (Number(balance.quantity || 0) !== 0 || Number(balance.reserved || 0) !== 0)
  );
  return hasReference || hasBalance ? "Нельзя удалить: по записи есть складская история или остаток" : null;
}
