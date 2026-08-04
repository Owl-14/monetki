import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("финансовые распределения создаются атомарным RPC и защищены триггером", async () => {
  const [baseMigration, guarantees, actions, events] = await Promise.all([
    read("../supabase/migrations/007_atomic_event_finance.sql"),
    read("../supabase/migrations/008_event_review_guarantees.sql"),
    read("../supabase/functions/api/actions.ts"),
    read("../supabase/functions/api/events.ts"),
  ]);
  const migration = `${baseMigration}\n${guarantees}`;
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
  assert.match(actions, /restoreEventGraph\(graph\)/);
  assert.doesNotMatch(actions, /restoreEventChild\(entity, item\)/);
  assert.match(events, /eventRpc\("event_restore_graph"/);
  assert.match(migration, /create or replace function public\.event_restore_child\(p_entity text, p_item jsonb\)/);
  assert.match(migration, /Резервная копия конфликтует с существующей историей события/);
});

test("регистрация уникальна атомарно и обе гонки создания дочерней строки с удалением закрыты", async () => {
  const migration = await read("../supabase/migrations/008_event_review_guarantees.sql");
  assert.match(migration, /create unique index if not exists records_event_registration_participant_unique/i);
  assert.match(migration, /data->>'eventId'.*data->>'participantType'.*data->>'participantId'/is);
  assert.match(migration, /select data into v_event from public\.records where entity = 'events' and id = v_event_id for update/i);
  assert.match(migration, /if v_event is null then raise exception 'Родительское событие не найдено'/i);
  assert.match(migration, /create or replace function public\.event_delete\(p_expected jsonb\)/i);
  assert.match(migration, /select data into v_event from public\.records where entity = 'events' and id = v_id for update/i);
  assert.match(migration, /entity in \('eventRegistrations', 'eventBudgetLines', 'eventFinanceAllocations'\).*data->>'eventId' = v_id/is);
  assert.match(migration, /v_rpc <> 'delete'/);
});

test("восстановление графа атомарно, повторяемо и строго проверяет бизнес связей", async () => {
  const [migration, actions, events] = await Promise.all([
    read("../supabase/migrations/008_event_review_guarantees.sql"),
    read("../supabase/functions/api/actions.ts"),
    read("../supabase/functions/api/events.ts"),
  ]);
  assert.match(migration, /create or replace function public\.event_restore_graph\(p_graph jsonb\)/i);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /v_existing is distinct from v_item/);
  assert.match(migration, /p_item->>'businessId' is distinct from v_business.*p_item->>'unit' is distinct from v_business/is);
  assert.match(migration, /v_finance->>'businessId' is distinct from v_business.*v_finance->>'unit' is distinct from v_business/is);
  assert.match(actions, /const graph = Object\.fromEntries\(EVENT_ENTITIES/);
  assert.match(actions, /restoreEventGraph\(graph\)/);
  assert.match(events, /eventRpc\("event_restore_graph"/);
});

test("закрытые ссылки и снимок начисления защищены на уровне БД", async () => {
  const [baseMigration, guarantees] = await Promise.all([
    read("../supabase/migrations/007_atomic_event_finance.sql"),
    read("../supabase/migrations/008_event_review_guarantees.sql"),
  ]);
  assert.match(baseMigration, /'staffRate', v_staff_rate/);
  assert.match(baseMigration, /'staffAmount', v_staff_amount/);
  assert.match(guarantees, /old\.entity in \('players', 'companies', 'contacts'\)/);
  assert.match(guarantees, /old\.entity = 'venues'/);
  assert.match(guarantees, /v_entity = 'events' and tg_op in \('INSERT', 'UPDATE'\)/);
  assert.match(guarantees, /entity = 'venues' and id = v_item->>'venueId'[\s\S]*for share/);
  assert.match(guarantees, /if not found then raise exception 'Площадка не найдена в этом бизнесе'/);
  assert.match(baseMigration, /order by entity, id for share/);
});

test("закрытие расчёта фиксирует снимок, историю и блокирует тихое переписывание", async () => {
  const migration = await read("../supabase/migrations/007_atomic_event_finance.sql");
  assert.match(migration, /create or replace function public\.event_close_settlement/);
  assert.match(migration, /Событие уже изменено другим запросом/);
  assert.match(migration, /settlementStatus', 'closed'/);
  assert.match(migration, /'action', 'settlement_closed'/);
  assert.match(migration, /Закрытый расчёт события нельзя изменять/);
  assert.match(migration, /round\(v_profit, 2\) - prior_amount/);
  const ownerReads = migration.match(/from public\.records where entity = 'businessOwners'[\s\S]{0,220}/g) || [];
  assert.ok(ownerReads.length >= 2);
  for (const ownerRead of ownerReads) {
    assert.match(ownerRead, /data->>'businessId' = v_business and data->>'unit' = v_business/);
    assert.doesNotMatch(ownerRead, /coalesce\(data->>'businessId', data->>'unit'/);
  }
});

test("миграция событий выполняется до публикации backend", async () => {
  const workflow = await read("../.github/workflows/deploy-backend.yml");
  const previous = workflow.indexOf("005_process_bank_transaction.sql");
  const recovery = workflow.indexOf("006_recover_hidden_bank_transactions.sql");
  const events = workflow.indexOf("007_atomic_event_finance.sql");
  const guarantees = workflow.indexOf("008_event_review_guarantees.sql");
  const deploy = workflow.indexOf("supabase functions deploy api");
  assert.ok(previous >= 0 && recovery > previous && events > recovery && guarantees > events && deploy > guarantees);
});
