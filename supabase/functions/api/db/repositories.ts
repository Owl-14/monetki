import { createClient } from "jsr:@supabase/supabase-js@2";

import type { Rec } from "../types.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

export async function readAll(entity: string): Promise<Rec[]> {
  const { data, error } = await db.from("records").select("data").eq("entity", entity);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.data as Rec);
}

export async function writeRow(entity: string, item: Rec) {
  const { error } = await db.from("records").upsert({ entity, id: item.id, data: item });
  if (error) throw new Error(error.message);
}

export async function insertRow(entity: string, item: Rec) {
  const { error } = await db.from("records").insert({ entity, id: item.id, data: item });
  if (error?.code === "23505") return false;
  if (error) throw new Error(error.message);
  return true;
}

export async function deleteRow(entity: string, id: string) {
  const { error } = await db.from("records").delete().eq("entity", entity).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function kvGet(key: string) {
  const { data } = await db.from("kv").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

export async function kvSet(key: string, value: unknown) {
  await db.from("kv").upsert({ key, value });
}

export async function readOne(entity: string, id: string): Promise<Rec | undefined> {
  const { data } = await db.from("records").select("data").eq("entity", entity).eq("id", id).maybeSingle();
  return data?.data as Rec | undefined;
}

export async function callRpc(name: string, args: Record<string, unknown>) {
  return await db.rpc(name, args);
}
