// ============ Монетки: серверная часть (Supabase Edge Function) ============
// Тот же протокол, что был у Google Apps Script: POST JSON {action, token, ...}.
// Данные — в таблице records (entity + data jsonb), доступ — только через эту функцию.

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

const ENTITIES = [
  "employees", "clients", "venues", "players",
  "tasks", "finance", "staffExpenses", "notifications",
];

type Rec = Record<string, unknown> & { id: string };

const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- Работа с таблицей ----------

async function readAll(entity: string): Promise<Rec[]> {
  const { data, error } = await db.from("records").select("data").eq("entity", entity);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.data as Rec);
}

async function writeRow(entity: string, item: Rec) {
  const { error } = await db.from("records").upsert({ entity, id: item.id, data: item });
  if (error) throw new Error(error.message);
}

async function deleteRow(entity: string, id: string) {
  const { error } = await db.from("records").delete().eq("entity", entity).eq("id", id);
  if (error) throw new Error(error.message);
}

async function kvGet(key: string) {
  const { data } = await db.from("kv").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

async function kvSet(key: string, value: unknown) {
  await db.from("kv").upsert({ key, value });
}

// ---------- Доступы ----------

async function findUser(token: unknown): Promise<Rec | null> {
  if (!token) return null;
  const users = await readAll("employees");
  return users.find((u) => String(u.code) === String(token) && u.active) ?? null;
}

const isAdmin = (u: Rec) => u.role === "admin";
const canSeeUnit = (u: Rec, unit: unknown) =>
  isAdmin(u) || u.unit === "all" || u.unit === unit;
const profileOf = (u: Rec) => ({
  id: u.id, name: u.name, role: u.role, unit: u.unit, phone: u.phone, tg: u.tg,
});

async function notify(toId: unknown, text: string, link = "#/tasks") {
  if (!toId) return;
  await writeRow("notifications", {
    id: newId(), toId, text, link, read: false, created: Date.now(),
  });
}

async function notifyAdmins(exceptId: string, text: string, link: string) {
  const emps = await readAll("employees");
  for (const a of emps) {
    if (a.role === "admin" && a.active && a.id !== exceptId) await notify(a.id, text, link);
  }
}

// ---------- Действия ----------

async function bootstrap(u: Rec) {
  const admin = isAdmin(u);
  const [employees, clients, venues, players, tasks, finance, staffExpenses, notifications] =
    await Promise.all(ENTITIES.map(readAll));
  const unitF = (list: Rec[]) => list.filter((x) => canSeeUnit(u, x.unit));
  return {
    ok: true,
    profile: profileOf(u),
    data: {
      employees: admin
        ? employees
        : employees.map((e) => ({ id: e.id, name: e.name, role: e.role, unit: e.unit, active: e.active })),
      clients: unitF(clients),
      venues: unitF(venues),
      players: unitF(players),
      tasks: unitF(tasks),
      finance: admin ? finance : finance.filter((f) => f.employeeId === u.id),
      staffExpenses: admin ? staffExpenses : staffExpenses.filter((e) => e.employeeId === u.id),
      bankBalance: admin ? await kvGet("BANK_BALANCE") : null,
      notifications: notifications.filter((n) => n.toId === u.id),
    },
  };
}

function checkWriteAccess(u: Rec, entity: string, item: Rec | null): string | null {
  if (!ENTITIES.includes(entity)) return "Неизвестная сущность";
  if ((entity === "employees" || entity === "finance") && !isAdmin(u)) return "Только для админа";
  if (entity === "notifications") return "Нельзя";
  if (item && item.unit && item.unit !== "all" && !canSeeUnit(u, item.unit)) {
    return "Нет доступа к этому направлению";
  }
  return null;
}

async function createItem(u: Rec, entity: string, item: Rec) {
  const deny = checkWriteAccess(u, entity, item);
  if (deny) return { ok: false, error: deny };
  item.id = item.id || newId();
  item.created = Date.now();
  item.updated = Date.now();
  if (entity === "employees" && !item.code) {
    item.code = String(Math.floor(100000 + Math.random() * 900000));
  }
  if (entity === "tasks") {
    item.authorId = item.authorId || u.id;
    item.comments = item.comments || [];
    if (item.assigneeId && item.assigneeId !== u.id) {
      await notify(item.assigneeId, `Новая задача: ${item.title}`);
    }
  }
  if (entity === "staffExpenses") {
    if (!isAdmin(u)) {
      item.employeeId = u.id;
      item.unit = u.unit === "all" ? (item.unit || "padel") : u.unit;
    }
    item.status = item.status || "pending";
    await notifyAdmins(u.id as string, `${u.name}: трата ${item.amount} ₽ — ${item.title}`, "#/finance");
  }
  if (entity === "finance" && item.employeeId) {
    await notify(
      item.employeeId,
      `Вам ${item.category === "Зарплата" ? "начислена зарплата" : "проведена выплата"}: ${item.amount} ₽`,
      "#/money",
    );
  }
  await writeRow(entity, item);
  return { ok: true, item };
}

async function updateItem(u: Rec, entity: string, item: Rec) {
  const deny = checkWriteAccess(u, entity, item);
  if (deny) return { ok: false, error: deny };
  const before = (await readAll(entity)).find((x) => x.id === item.id);
  if (!before) return { ok: false, error: "Не найдено" };
  if (!canSeeUnit(u, before.unit ?? item.unit)) return { ok: false, error: "Нет доступа" };
  if (entity === "staffExpenses" && !isAdmin(u)) {
    if (before.employeeId !== u.id) return { ok: false, error: "Нет доступа" };
    if (before.status !== "pending") return { ok: false, error: "Эта трата уже возвращена" };
    item.employeeId = u.id;
    item.status = "pending";
  }
  const merged = { ...before, ...item, updated: Date.now() } as Rec;
  if (entity === "tasks") {
    if (before.status !== "done" && merged.status === "done" && merged.authorId && merged.authorId !== u.id) {
      await notify(merged.authorId, `Задача выполнена: ${merged.title}`);
    }
    if (before.assigneeId !== merged.assigneeId && merged.assigneeId && merged.assigneeId !== u.id) {
      await notify(merged.assigneeId, `Вам передали задачу: ${merged.title}`);
    }
  }
  await writeRow(entity, merged);
  return { ok: true, item: merged };
}

async function deleteItem(u: Rec, entity: string, id: string) {
  const before = (await readAll(entity)).find((x) => x.id === id);
  if (!before) return { ok: false, error: "Не найдено" };
  const deny = checkWriteAccess(u, entity, before);
  if (deny) return { ok: false, error: deny };
  if (entity === "staffExpenses" && !isAdmin(u) && (before.employeeId !== u.id || before.status !== "pending")) {
    return { ok: false, error: "Нет доступа" };
  }
  await deleteRow(entity, id);
  return { ok: true };
}

async function addComment(u: Rec, taskId: string, text: string) {
  const task = (await readAll("tasks")).find((t) => t.id === taskId);
  if (!task) return { ok: false, error: "Задача не найдена" };
  if (!canSeeUnit(u, task.unit)) return { ok: false, error: "Нет доступа" };
  const comments = (task.comments as Rec[]) || [];
  comments.push({ authorId: u.id, text: String(text).slice(0, 2000), ts: Date.now() } as Rec);
  task.comments = comments;
  await writeRow("tasks", task);
  const others = [...new Set([task.authorId, task.assigneeId].filter((id) => id && id !== u.id))];
  for (const id of others) {
    await notify(id, `${u.name}: ${String(text).slice(0, 80)} (задача «${task.title}»)`);
  }
  return { ok: true, item: task };
}

async function importPlayers(u: Rec, rows: Rec[]) {
  if (!canSeeUnit(u, "padel")) return { ok: false, error: "Нет доступа" };
  const existing = await readAll("players");
  let added = 0;
  for (const r of rows || []) {
    if (!r.name) continue;
    const dup = existing.find((p) =>
      String(p.name).toLowerCase() === String(r.name).toLowerCase() &&
      String(p.phone || "") === String(r.phone || "")
    );
    if (dup) continue;
    await writeRow("players", {
      id: newId(), unit: "padel", name: r.name, phone: r.phone || "",
      level: r.level || "", city: r.city || "", notes: r.notes || "",
      created: Date.now(), updated: Date.now(),
    });
    added++;
  }
  return { ok: true, added };
}

async function markRead(u: Rec, ids: string[]) {
  const notifs = await readAll("notifications");
  for (const n of notifs) {
    if ((ids || []).includes(n.id) && n.toId === u.id && !n.read) {
      n.read = true;
      await writeRow("notifications", n);
    }
  }
  return { ok: true };
}

async function resolveExpense(u: Rec, id: string, how: string) {
  if (!isAdmin(u)) return { ok: false, error: "Только для админа" };
  const ex = (await readAll("staffExpenses")).find((x) => x.id === id);
  if (!ex) return { ok: false, error: "Не найдено" };
  if (ex.status !== "pending") return { ok: false, error: "Уже возвращено" };
  ex.status = how === "cash" ? "returned_cash" : "returned_bank";
  ex.updated = Date.now();
  await writeRow("staffExpenses", ex);
  if (how === "cash") {
    const emp = (await readAll("employees")).find((e) => e.id === ex.employeeId);
    await writeRow("finance", {
      id: newId(), unit: ex.unit, date: new Date().toISOString().slice(0, 10),
      type: "expense", amount: ex.amount, method: "cash", source: "manual",
      category: "Компенсация сотруднику", counterparty: emp ? emp.name : "",
      comment: ex.title, bankId: "", employeeId: ex.employeeId,
      created: Date.now(), updated: Date.now(),
    });
  }
  await notify(ex.employeeId, `Вам вернули ${ex.amount} ₽ (${how === "cash" ? "наличными" : "со счёта"}) — ${ex.title}`, "#/money");
  return { ok: true, item: ex };
}

async function statusInfo() {
  const [employees, finance, staffExpenses] = await Promise.all([
    readAll("employees"), readAll("finance"), readAll("staffExpenses"),
  ]);
  return {
    ok: true,
    backend: "supabase",
    employees: employees.length,
    tochkaTokenSet: !!Deno.env.get("TOCHKA_TOKEN"),
    financeTotal: finance.length,
    financeFromBank: finance.filter((f) => f.source === "bank").length,
    staffExpensesPending: staffExpenses.filter((e) => e.status === "pending").length,
    lastSync: await kvGet("LAST_SYNC"),
  };
}

// Первичный импорт резервной копии со старой базы.
// Разрешён без токена ТОЛЬКО пока база пустая (нет ни одного сотрудника).
async function migrateImport(u: Rec | null, payload: Record<string, Rec[]>) {
  const empty = (await readAll("employees")).length === 0;
  if (!empty && (!u || !isAdmin(u))) return { ok: false, error: "Только для админа" };
  let total = 0;
  for (const entity of ENTITIES) {
    for (const item of payload?.[entity] || []) {
      if (!item || !item.id) continue;
      await writeRow(entity, item);
      total++;
    }
  }
  return { ok: true, imported: total };
}

// ---------- Точка Банк ----------

const TOCHKA = "https://enter.tochka.com/uapi";

async function tochkaFetch(path: string, init?: RequestInit) {
  const token = Deno.env.get("TOCHKA_TOKEN");
  if (!token) throw new Error("Не задан секрет TOCHKA_TOKEN");
  const resp = await fetch(TOCHKA + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`Точка API ${resp.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

function classifyMethod(t: Rec): string {
  const ttc = String(t.transactionTypeCode || "");
  if (/Банковские карты/i.test(ttc)) return "card";
  if (/Денежный чек|взнос наличными/i.test(ttc)) return "cash";
  const side = (t.creditDebitIndicator === "Credit" ? t.DebtorAccount : t.CreditorAccount) as Rec | undefined;
  const scheme = side?.schemeName || "";
  if (scheme === "RU.CBR.PAN") return "card";
  if (scheme === "RU.CBR.CellphoneNumber") return "sbp";
  const p = String(t.description || "").toLowerCase();
  if (/сбп|c2b|нспк|быстрых платежей|qr/.test(p)) return "sbp";
  if (/карт|терминал|pos/.test(p)) return "card";
  if (/наличн|банкомат|atm/.test(p)) return "cash";
  return "account";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tochkaSync(days = 30) {
  const unit = Deno.env.get("TOCHKA_UNIT") || "padel";
  const accountsRes = await tochkaFetch("/open-banking/v1.0/accounts");
  const accounts: Rec[] = accountsRes?.Data?.Account || [];
  if (!accounts.length) return { ok: false, error: "Счета не найдены" };

  const end = new Date();
  const start = new Date(end.getTime() - days * 864e5);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const existing = await readAll("finance");
  const known = new Set(existing.map((f) => f.bankId).filter(Boolean));
  let added = 0;

  for (const acc of accounts) {
    const accountId = String(acc.accountId);
    const init = await tochkaFetch("/open-banking/v1.0/statements", {
      method: "POST",
      body: JSON.stringify({
        Data: { Statement: { accountId, startDateTime: fmt(start), endDateTime: fmt(end) } },
      }),
    });
    const stId = init?.Data?.Statement?.statementId;
    if (!stId) continue;

    let st: Rec | null = null;
    for (let i = 0; i < 20; i++) {
      await sleep(3000);
      const got = await tochkaFetch(
        `/open-banking/v1.0/accounts/${encodeURIComponent(accountId)}/statements/${encodeURIComponent(stId)}`,
      );
      const d = got?.Data?.Statement;
      st = Array.isArray(d) ? d[0] : d;
      if (st && (st.status === "Ready" || st.status === "Error" || st.Transaction)) break;
    }
    if (!st || st.status === "Error") continue;

    for (const t of (st.Transaction as Rec[]) || []) {
      if (t.status === "Pending") continue;
      const amount = Number((t.Amount as Rec)?.amount) || 0;
      const bankId = String(t.transactionId || t.paymentId ||
        `${t.documentNumber || ""}|${amount}|${t.documentProcessDate}`);
      if (known.has(bankId)) continue;
      known.add(bankId);
      const isIncome = t.creditDebitIndicator === "Credit";
      const cp = isIncome
        ? ((t.DebtorParty as Rec)?.name || "")
        : ((t.CreditorParty as Rec)?.name || "");
      await writeRow("finance", {
        id: newId(), unit,
        date: String(t.documentProcessDate || fmt(new Date())).slice(0, 10),
        type: isIncome ? "income" : "expense",
        amount,
        method: classifyMethod(t),
        source: "bank",
        category: isIncome ? "Оплата клиента" : "Прочее",
        counterparty: cp,
        comment: String(t.description || "").slice(0, 300),
        bankId, created: Date.now(), updated: Date.now(),
      });
      added++;
    }
  }

  // Остаток: суммы как отдаёт банк, знак НЕ переворачиваем
  try {
    const balRes = await tochkaFetch("/open-banking/v1.0/balances");
    const bals: Rec[] = balRes?.Data?.Balance || [];
    const byAcc = new Map<string, Rec>();
    const rank = (t: unknown) => (t === "ClosingAvailable" ? 3 : t === "Expected" ? 2 : 1);
    for (const b of bals) {
      const key = String(b.accountId || "?");
      if (!byAcc.has(key) || rank(b.type) > rank(byAcc.get(key)!.type)) byAcc.set(key, b);
    }
    let total = 0;
    for (const b of byAcc.values()) total += Number((b.Amount as Rec)?.amount) || 0;
    await kvSet("BANK_BALANCE", { amount: total, updated: new Date().toISOString() });
  } catch (_e) { /* остаток не критичен */ }

  await kvSet("LAST_SYNC", `${new Date().toISOString()} | добавлено операций: ${added}`);
  return { ok: true, added };
}

// ---------- HTTP ----------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") {
    return new Response(JSON.stringify({ ok: true, app: "monetki", backend: "supabase" }), { headers: CORS });
  }
  try {
    const body = await req.json();
    const action = body.action;

    if (action === "login") {
      const u = await findUser(body.code);
      if (!u) return json({ ok: false, error: "Неверный код доступа" });
      return json({ ok: true, token: u.code, profile: profileOf(u) });
    }
    if (action === "status") return json(await statusInfo());
    if (action === "tochka_sync") return json(await tochkaSync(body.days || 30));
    if (action === "migrate_import") {
      return json(await migrateImport(await findUser(body.token), body.data));
    }

    const user = await findUser(body.token);
    if (!user) return json({ ok: false, error: "auth" });

    switch (action) {
      case "bootstrap": return json(await bootstrap(user));
      case "create": return json(await createItem(user, body.entity, body.item));
      case "update": return json(await updateItem(user, body.entity, body.item));
      case "delete": return json(await deleteItem(user, body.entity, body.id));
      case "comment": return json(await addComment(user, body.taskId, body.text));
      case "import_players": return json(await importPlayers(user, body.rows));
      case "mark_read": return json(await markRead(user, body.ids));
      case "resolve_expense": return json(await resolveExpense(user, body.id, body.how));
      default: return json({ ok: false, error: "Неизвестное действие" });
    }
  } catch (e) {
    return json({ ok: false, error: "Ошибка сервера: " + (e as Error).message });
  }
});

function json(obj: unknown) {
  return new Response(JSON.stringify(obj), { headers: CORS });
}
