-- Атомарная аренда для синхронизации Точка Банка.
-- Хранится в закрытой records и не требует нового секрета.

create or replace function public.acquire_tochka_sync_lease(
  p_lease_id text,
  p_lease_seconds integer default 210
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  acquired boolean := false;
  v_now timestamptz := clock_timestamp();
  v_expires_at timestamptz;
begin
  if p_lease_id is null or length(p_lease_id) < 16 or length(p_lease_id) > 128 then
    return false;
  end if;

  v_expires_at := v_now + make_interval(secs => least(greatest(p_lease_seconds, 1), 600));
  insert into public.records(entity, id, data)
  values (
    '_locks',
    'tochka_sync',
    jsonb_build_object(
      'id', 'tochka_sync',
      'leaseId', p_lease_id,
      'expiresAt', v_expires_at,
      'expiresAtEpoch', extract(epoch from v_expires_at)::bigint
    )
  )
  on conflict (entity, id) do update
  set data = excluded.data
  where case
    when jsonb_typeof(records.data -> 'expiresAtEpoch') = 'number'
      then (records.data ->> 'expiresAtEpoch')::numeric <= extract(epoch from v_now)
    else true
  end
  returning true into acquired;

  return coalesce(acquired, false);
end;
$$;

create or replace function public.release_tochka_sync_lease(p_lease_id text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  released_count integer := 0;
begin
  delete from public.records
  where entity = '_locks'
    and id = 'tochka_sync'
    and data ->> 'leaseId' = p_lease_id;
  get diagnostics released_count = row_count;
  return released_count = 1;
end;
$$;

revoke all on function public.acquire_tochka_sync_lease(text, integer) from public;
revoke all on function public.release_tochka_sync_lease(text) from public;
grant execute on function public.acquire_tochka_sync_lease(text, integer) to service_role;
grant execute on function public.release_tochka_sync_lease(text) to service_role;

notify pgrst, 'reload schema';
