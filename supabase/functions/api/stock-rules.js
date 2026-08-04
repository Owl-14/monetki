import { businessIdOf, scopeMismatch } from "./rules.js";

export const STOCK_ENTITIES = [
  "warehouses", "stockItems", "stockMovements", "stockBalances", "reservations", "inventories",
];

export const STOCK_MOVEMENT_TYPES = ["receipt", "expense", "transfer", "inventory"];
export const STOCK_RESERVATION_STATUSES = ["active", "released"];
export const STOCK_INVENTORY_STATUSES = ["draft", "completed"];

export const stockBalanceKey = (warehouseId, stockItemId) =>
  `${String(warehouseId || "")}::${String(stockItemId || "")}`;

export function stockModuleEnabled(businesses, businessId) {
  const business = (businesses || []).find((item) => item.id === businessId);
  return !!business && business.active !== false && Array.isArray(business.modules) && business.modules.includes("stock");
}

export function stockModuleWriteError(businesses, item) {
  const businessId = businessIdOf(item);
  if (!(businesses || []).some((business) => business.id === businessId && business.active !== false)) {
    return "Бизнес в архиве";
  }
  if (!stockModuleEnabled(businesses, businessId)) return "Модуль «Склад» отключён";
  return null;
}

function positiveNumber(value) {
  const number = Number(value);
  return value !== "" && value !== null && Number.isFinite(number) && number > 0;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return value !== "" && value !== null && Number.isFinite(number) && number >= 0;
}

function activeScopedRecord(records, id, businessId) {
  return (records || []).find((record) =>
    record.id === id && businessIdOf(record) === businessId && record.active !== false
  );
}

export function stockMovementDeltas(item) {
  const quantity = Number(item?.quantity);
  switch (item?.type) {
    case "receipt": return [{ warehouseId: item.warehouseId, delta: quantity }];
    case "expense": return [{ warehouseId: item.warehouseId, delta: -quantity }];
    case "transfer": return [
      { warehouseId: item.fromWarehouseId, delta: -quantity },
      { warehouseId: item.toWarehouseId, delta: quantity },
    ];
    case "inventory": return [{
      warehouseId: item.warehouseId,
      delta: item.direction === "increase" ? quantity : -quantity,
    }];
    default: return [];
  }
}

export function inventoryAdjustments(inventory, balances) {
  const current = new Map((balances || [])
    .filter((balance) =>
      balance.warehouseId === inventory?.warehouseId && businessIdOf(balance) === businessIdOf(inventory)
    )
    .map((balance) => [balance.stockItemId, Number(balance.quantity) || 0]));
  return (inventory?.items || []).map((line) => {
    const previousQuantity = current.get(line.stockItemId) || 0;
    const actualQuantity = Number(line.actualQuantity);
    return {
      stockItemId: line.stockItemId,
      previousQuantity,
      actualQuantity,
      delta: actualQuantity - previousQuantity,
    };
  });
}

export function reservationQuantity(item) {
  return item?.status === "active" ? Number(item.quantity) || 0 : 0;
}

export function stockRecordError(entity, item, data, ignoreId = "") {
  if (!STOCK_ENTITIES.includes(entity)) return null;
  if (scopeMismatch(item)) return "businessId и unit должны совпадать";
  const businessId = businessIdOf(item);
  if (!businessId) return "Не указан бизнес";

  if (entity === "warehouses") {
    if (!String(item?.name || "").trim()) return "Не указано название склада";
    if (typeof item?.active !== "boolean") return "Статус склада должен быть логическим";
  }

  if (entity === "stockItems") {
    if (!String(item?.name || "").trim()) return "Не указано название позиции";
    if (!String(item?.unitName || "").trim()) return "Не указана единица измерения";
    if (!nonNegativeNumber(item?.costPrice)) return "Себестоимость должна быть неотрицательным числом";
    if (!nonNegativeNumber(item?.minStock)) return "Минимальный остаток должен быть неотрицательным числом";
    if (typeof item?.active !== "boolean") return "Статус позиции должен быть логическим";
    const sku = String(item?.sku || "").trim().toLowerCase();
    if (sku && (data.stockItems || []).some((record) =>
      record.id !== ignoreId && businessIdOf(record) === businessId && String(record.sku || "").trim().toLowerCase() === sku
    )) return "Позиция с таким артикулом уже существует";
  }

  if (entity === "stockMovements") {
    if (!STOCK_MOVEMENT_TYPES.includes(String(item?.type || ""))) return "Неизвестный тип движения";
    if (!positiveNumber(item?.quantity)) return "Количество должно быть больше нуля";
    const stockItem = activeScopedRecord(data.stockItems, item?.stockItemId, businessId);
    if (!stockItem) return "Позиция склада не найдена в этом бизнесе";
    if (item.type === "transfer") {
      if (!item.fromWarehouseId || !item.toWarehouseId || item.fromWarehouseId === item.toWarehouseId) {
        return "Для перемещения нужны два разных склада";
      }
      if (!activeScopedRecord(data.warehouses, item.fromWarehouseId, businessId) ||
          !activeScopedRecord(data.warehouses, item.toWarehouseId, businessId)) {
        return "Склад не найден в этом бизнесе";
      }
    } else {
      if (!activeScopedRecord(data.warehouses, item?.warehouseId, businessId)) return "Склад не найден в этом бизнесе";
    }
    if (item.type === "inventory" && !["increase", "decrease"].includes(String(item?.direction || ""))) {
      return "Не указано направление корректировки";
    }
    if (item.type === "receipt") {
      if (item.totalAmount !== undefined && item.totalAmount !== "" && !nonNegativeNumber(item.totalAmount)) {
        return "Сумма прихода должна быть неотрицательным числом";
      }
      if (item.financeId && !(data.finance || []).some((record) =>
        record.id === item.financeId && businessIdOf(record) === businessId && record.type === "expense"
      )) return "Финансовая операция не найдена в этом бизнесе";
    }
  }

  if (entity === "stockBalances") {
    if (!activeScopedRecord(data.warehouses, item?.warehouseId, businessId)) return "Склад не найден в этом бизнесе";
    if (!activeScopedRecord(data.stockItems, item?.stockItemId, businessId)) return "Позиция склада не найдена в этом бизнесе";
    if (!nonNegativeNumber(item?.quantity) || !nonNegativeNumber(item?.reserved)) return "Остаток и резерв должны быть неотрицательными";
    if (Number(item.reserved) > Number(item.quantity)) return "Резерв не может превышать остаток";
  }

  if (entity === "reservations") {
    if (!STOCK_RESERVATION_STATUSES.includes(String(item?.status || ""))) return "Неизвестный статус резерва";
    if (!positiveNumber(item?.quantity)) return "Количество резерва должно быть больше нуля";
    if (!activeScopedRecord(data.warehouses, item?.warehouseId, businessId)) return "Склад не найден в этом бизнесе";
    if (!activeScopedRecord(data.stockItems, item?.stockItemId, businessId)) return "Позиция склада не найдена в этом бизнесе";
  }

  if (entity === "inventories") {
    if (!STOCK_INVENTORY_STATUSES.includes(String(item?.status || ""))) return "Неизвестный статус инвентаризации";
    if (!activeScopedRecord(data.warehouses, item?.warehouseId, businessId)) return "Склад не найден в этом бизнесе";
    if (!Array.isArray(item?.items) || !item.items.length) return "Добавьте позиции инвентаризации";
    const seen = new Set();
    for (const line of item.items) {
      if (!line?.stockItemId || seen.has(line.stockItemId)) return "Позиции инвентаризации не должны повторяться";
      seen.add(line.stockItemId);
      if (!activeScopedRecord(data.stockItems, line.stockItemId, businessId)) return "Позиция склада не найдена в этом бизнесе";
      if (!nonNegativeNumber(line.actualQuantity)) return "Фактический остаток должен быть неотрицательным числом";
    }
  }

  return null;
}

export function stockAvailabilityError(item, balances) {
  for (const change of stockMovementDeltas(item)) {
    const balance = (balances || []).find((record) =>
      businessIdOf(record) === businessIdOf(item) &&
      record.warehouseId === change.warehouseId && record.stockItemId === item.stockItemId
    );
    const quantity = Number(balance?.quantity) || 0;
    const reserved = Number(balance?.reserved) || 0;
    if (change.delta < 0 && quantity + change.delta < reserved) {
      return reserved > 0 ? "Недостаточно свободного остатка: часть товара зарезервирована" : "Недостаточно товара на складе";
    }
  }
  return null;
}
