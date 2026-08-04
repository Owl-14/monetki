import { callRpc, readAll } from "./db/repositories.ts";
import type { Rec } from "./types.ts";

export async function readEventData() {
  const names = [
    "businesses", "memberships", "businessOwners", "eventTypes", "events",
    "eventRegistrations", "eventBudgetLines", "eventFinanceAllocations",
    "finance", "venues", "players", "companies", "contacts",
  ];
  const rows = await Promise.all(names.map(readAll));
  return Object.fromEntries(names.map((name, index) => [name, rows[index]])) as Record<string, Rec[]>;
}

async function eventRpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await callRpc(name, args);
  if (error) return { ok: false, error: error.message || "Не удалось выполнить операцию события" };
  if (!data || typeof data !== "object") return { ok: false, error: "Сервер не вернул результат операции события" };
  return data as { ok: boolean; error?: string; item?: Rec; alreadyAllocated?: boolean; alreadyClosed?: boolean };
}

export async function allocateEventFinance(item: Rec, restore = false) {
  return await eventRpc("event_allocate_finance", { p_item: item, p_restore: restore });
}

export async function restoreEventGraph(graph: Record<string, Rec[]>) {
  return await eventRpc("event_restore_graph", { p_graph: graph });
}

export async function closeEventSettlement(event: Rec, userId: string) {
  return await eventRpc("event_close_settlement", { p_expected: event, p_user_id: userId });
}

export async function deleteEvent(event: Rec) {
  return await eventRpc("event_delete", { p_expected: event });
}
