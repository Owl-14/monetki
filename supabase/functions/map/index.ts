// ============ Хранилище согласования карты CRM ============
// Отдельная функция для страницы https://owl-14.github.io/crm-map
// Хранит решения и комментарии по разделам карты, чтобы обе стороны
// видели правки друг друга. Данные лежат в таблице kv одной записью.

import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Content-Type": "application/json",
};

const json = (o: unknown) => new Response(JSON.stringify(o), { headers: CORS });

// Ключ раздела карты: код модуля + номер, например CORE-0
const KEY_RE = /^[A-Z]{2,6}-\d{1,2}$/;
const cut = (s: unknown, n: number) => String(s ?? "").slice(0, n);

type Item = { v: string | null; c: string; a: string; by: string; ts: number };
type Doc = { items: Record<string, Item>; updated: string };

async function load(doc: string): Promise<Doc> {
  const { data } = await db.from("kv").select("value").eq("key", "crmmap:" + doc).maybeSingle();
  const v = data?.value as Doc | null;
  return v && typeof v === "object" && v.items ? v : { items: {}, updated: "" };
}

async function store(doc: string, d: Doc) {
  await db.from("kv").upsert({ key: "crmmap:" + doc, value: d });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, app: "crm-map" });

  try {
    const body = await req.json();
    const doc = cut(body.doc || "v2", 24).replace(/[^\w.-]/g, "");
    const action = body.action;

    if (action === "get") {
      const d = await load(doc);
      return json({ ok: true, items: d.items, updated: d.updated });
    }

    // Сохранение одного раздела: сервер сливает правку с общим документом,
    // поэтому одновременная работа двух человек ничего не затирает.
    if (action === "set") {
      const k = String(body.k || "");
      if (!KEY_RE.test(k)) return json({ ok: false, error: "Неизвестный раздел" });
      const p = body.patch || {};
      const v = p.v === "ok" || p.v === "no" ? p.v : null;
      const d = await load(doc);
      const prev = d.items[k] || { v: null, c: "", a: "", by: "", ts: 0 };
      d.items[k] = {
        v,
        c: cut(p.c ?? prev.c, 2000),
        a: cut(p.a ?? prev.a, 4000),
        by: cut(body.by || prev.by, 60),
        ts: Date.now(),
      };
      if (Object.keys(d.items).length > 400) return json({ ok: false, error: "Слишком много записей" });
      d.updated = new Date().toISOString();
      await store(doc, d);
      return json({ ok: true, item: d.items[k], updated: d.updated });
    }

    if (action === "clear") {
      const k = String(body.k || "");
      if (!KEY_RE.test(k)) return json({ ok: false, error: "Неизвестный раздел" });
      const d = await load(doc);
      delete d.items[k];
      d.updated = new Date().toISOString();
      await store(doc, d);
      return json({ ok: true, updated: d.updated });
    }

    return json({ ok: false, error: "Неизвестное действие" });
  } catch (e) {
    return json({ ok: false, error: "Ошибка сервера: " + (e as Error).message });
  }
});
