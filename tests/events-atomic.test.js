import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("финансовые распределения создаются атомарным RPC и защищены триггером", async () => {
  const [migration, actions, events] = await Promise.all([
    read("../supabase/migrations/007_atomic_event_finance.sql"),
    read("../supabase/functions/api/actions.ts"),
    read("../supabase/functions/api/events.ts"),
  ]);
  assert.match(migration, /create or replace function public\.event_allocate_finance\(p_item jsonb, p_restore boolean default false\)/i);
  assert.match(migration, /for update/i);
  assert.match(migration, /Нельзя распределить больше суммы финансовой операции/);
  assert.match(migration, /v_amount <> round\(v_amount, 2\)/);
  assert.match(migration, /round\(v_allocated \* 100\)::bigint/);
  assert.match(migration, /md5\(v_business \|\| ':' \|\| v_key\)/);
  assert.match(migration, /eventFinanceAllocations.*неизменяемы/is);
  assert.match(migration, /Регистрацию со связанной оплатой нельзя удалить/);
  assert.match(migration, /Строку бюджета со связанной финансовой операцией нельзя удалить/);
  assert.match(migration, /create trigger event_protect_records_trigger/i);
  assert.match(migration, /select data into v_event from public\.records where entity = 'events' and id = v_event_id for update/);
  assert.match(migration, /revoke all on function public\.event_allocate_finance\(jsonb, boolean\) from public, anon, authenticated/i);
  assert.match(events, /eventRpc\("event_allocate_finance"/);
  assert.match(actions, /export async function createEventFinanceAllocation/);
  assert.match(actions, /export async function closeEventSettlement/);
  assert.match(actions, /allocateEventFinance\(item, true\)/);
  assert.match(actions, /restoreEventChild\(entity, item\)/);
  assert.match(migration, /create or replace function public\.event_restore_child\(p_entity text, p_item jsonb\)/);
  assert.match(migration, /Резервная копия конфликтует с существующей историей события/);
});

test("закрытие расчёта фиксирует снимок, историю и блокирует тихое переписывание", async () => {
  const migration = await read("../supabase/migrations/007_atomic_event_finance.sql");
  assert.match(migration, /create or replace function public\.event_close_settlement/);
  assert.match(migration, /Событие уже изменено другим запросом/);
  assert.match(migration, /settlementStatus', 'closed'/);
  assert.match(migration, /'action', 'settlement_closed'/);
  assert.match(migration, /Закрытый расчёт события нельзя изменять/);
  assert.match(migration, /round\(v_profit, 2\) - prior_amount/);
});

test("миграция событий выполняется до публикации backend", async () => {
  const workflow = await read("../.github/workflows/deploy-backend.yml");
  const previous = workflow.indexOf("005_process_bank_transaction.sql");
  const recovery = workflow.indexOf("006_recover_hidden_bank_transactions.sql");
  const events = workflow.indexOf("007_atomic_event_finance.sql");
  const deploy = workflow.indexOf("supabase functions deploy api");
  assert.ok(previous >= 0 && recovery > previous && events > recovery && deploy > events);
});
