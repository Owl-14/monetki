-- ============ Монетки: схема базы Supabase ============
-- Выполните один раз в Supabase: SQL Editor → New query → вставить всё → Run.

-- Все данные лежат в одной таблице records: entity — тип записи
-- (employees / clients / venues / players / tasks / finance / staffExpenses / notifications),
-- data — сама запись в JSON. Это зеркало прежней структуры, поэтому переезд без потерь.
create table if not exists records (
  entity text not null,
  id text not null,
  data jsonb not null,
  primary key (entity, id)
);
create index if not exists records_entity_idx on records (entity);

-- Служебное хранилище (остаток банка, отметка последней синхронизации)
create table if not exists kv (
  key text primary key,
  value jsonb
);

-- Закрываем прямой доступ: политик нет, значит с публичным (anon) ключом
-- данные недоступны вообще. Работает только серверная функция api.
alter table records enable row level security;
alter table kv enable row level security;

-- Расширения для ежечасной синхронизации с банком
create extension if not exists pg_cron;
create extension if not exists pg_net;
