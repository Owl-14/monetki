-- Атомарное проведение записи из банковской очереди в finance.
-- Миграция добавляет только функцию и не переписывает существующие данные.

create or replace function public.process_bank_transaction(
  p_queue_id text,
  p_business_id text,
  p_category text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pending jsonb;
  v_existing jsonb;
  v_item jsonb;
  v_bank_id text;
  v_finance_id text;
  v_now bigint := floor(extract(epoch from clock_timestamp()) * 1000);
begin
  if coalesce(length(trim(p_queue_id)), 0) < 1 or length(p_queue_id) > 128 then
    raise exception 'Некорректная банковская операция';
  end if;
  if coalesce(length(trim(p_business_id)), 0) < 1 or length(p_business_id) > 63 then
    raise exception 'Некорректный бизнес';
  end if;
  if coalesce(length(trim(p_category)), 0) < 1 or length(trim(p_category)) > 120 then
    raise exception 'Некорректная категория';
  end if;

  v_finance_id := 'bank:' || p_queue_id;
  select data into v_pending
  from public.records
  where entity = 'bankTransactions' and id = p_queue_id
  for update;

  -- Повтор после успешной транзакции возвращает уже созданную запись.
  if v_pending is null then
    select data into v_existing
    from public.records
    where entity = 'finance' and id = v_finance_id;
    if v_existing is not null then
      return jsonb_build_object('ok', true, 'item', v_existing, 'alreadyProcessed', true);
    end if;
    return jsonb_build_object('ok', false, 'error', 'Банковская операция не найдена');
  end if;

  if not exists (
    select 1 from public.records
    where entity = 'businesses' and id = p_business_id
      and coalesce((data ->> 'active')::boolean, true)
  ) then
    return jsonb_build_object('ok', false, 'error', 'Бизнес не найден или находится в архиве');
  end if;

  v_bank_id := v_pending ->> 'bankId';
  if coalesce(length(v_bank_id), 0) < 1 then
    return jsonb_build_object('ok', false, 'error', 'У банковской операции нет идентификатора');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_bank_id, 0));

  -- Совместимость со старыми finance: их bankId остаётся главным дедуп-ключом.
  select data into v_existing
  from public.records
  where entity = 'finance' and data ->> 'bankId' = v_bank_id
  limit 1;
  if v_existing is not null then
    delete from public.records where entity = 'bankTransactions' and id = p_queue_id;
    return jsonb_build_object('ok', true, 'item', v_existing, 'alreadyProcessed', true);
  end if;

  v_item := jsonb_build_object(
    'id', v_finance_id,
    'businessId', p_business_id,
    'unit', p_business_id,
    'date', left(coalesce(v_pending ->> 'date', current_date::text), 10),
    'type', case when v_pending ->> 'type' = 'income' then 'income' else 'expense' end,
    'amount', coalesce(v_pending -> 'amount', '0'::jsonb),
    'method', coalesce(v_pending ->> 'method', 'account'),
    'source', 'bank',
    'category', trim(p_category),
    'counterparty', left(coalesce(v_pending ->> 'counterparty', ''), 300),
    'comment', left(coalesce(v_pending ->> 'comment', ''), 300),
    'bankId', v_bank_id,
    'bankQueueId', p_queue_id,
    'created', coalesce(v_pending -> 'created', to_jsonb(v_now)),
    'updated', v_now
  );

  insert into public.records(entity, id, data)
  values ('finance', v_finance_id, v_item)
  on conflict (entity, id) do nothing;

  select data into v_existing
  from public.records
  where entity = 'finance' and id = v_finance_id;
  if v_existing is null or v_existing ->> 'bankId' is distinct from v_bank_id then
    raise exception 'Не удалось безопасно провести банковскую операцию';
  end if;

  delete from public.records where entity = 'bankTransactions' and id = p_queue_id;
  return jsonb_build_object('ok', true, 'item', v_existing);
end;
$$;

revoke all on function public.process_bank_transaction(text, text, text) from public;
grant execute on function public.process_bank_transaction(text, text, text) to service_role;

notify pgrst, 'reload schema';
