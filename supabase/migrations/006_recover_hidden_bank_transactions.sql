-- Возвращает в банковскую очередь старые операции finance, которые синхронизация
-- сохранила без существующего бизнеса. Валидные и архивные бизнесы не затрагиваются.
-- Блок выполняется атомарно и идемпотентно при каждом backend-deploy.

create extension if not exists pgcrypto with schema extensions;

do $$
declare
  v_record record;
  v_bank_id text;
  v_queue_id text;
  v_queue_hash text;
  v_queue_data jsonb;
  v_existing_finance jsonb;
  v_existing_queue jsonb;
  v_pgcrypto_schema name;
  v_now bigint := floor(extract(epoch from clock_timestamp()) * 1000);
begin
  select namespace.nspname into v_pgcrypto_schema
  from pg_catalog.pg_extension ext
  join pg_catalog.pg_namespace namespace on namespace.oid = ext.extnamespace
  where ext.extname = 'pgcrypto';
  if v_pgcrypto_schema is null then
    raise exception 'Расширение pgcrypto недоступно';
  end if;

  for v_record in
    select finance.id, finance.data
    from public.records finance
    where finance.entity = 'finance'
      and finance.data ->> 'source' = 'bank'
      and coalesce(length(finance.data ->> 'bankId'), 0) > 0
      and (
        coalesce(
          nullif(finance.data ->> 'businessId', ''),
          nullif(finance.data ->> 'unit', ''),
          ''
        ) in ('', 'all')
        or (
          coalesce(length(finance.data ->> 'businessId'), 0) > 0
          and coalesce(length(finance.data ->> 'unit'), 0) > 0
          and finance.data ->> 'businessId' <> finance.data ->> 'unit'
        )
        or not exists (
          select 1
          from public.records business
          where business.entity = 'businesses'
            and business.id = coalesce(
              nullif(finance.data ->> 'businessId', ''),
              nullif(finance.data ->> 'unit', '')
            )
        )
      )
    order by finance.id
    for update
  loop
    v_bank_id := v_record.data ->> 'bankId';
    perform pg_advisory_xact_lock(hashtextextended(v_bank_id, 0));

    if exists (
      select 1
      from public.records movement
      where movement.entity = 'stockMovements'
        and movement.data ->> 'financeId' = v_record.id
    ) then
      raise exception 'Нельзя автоматически переместить банковскую операцию, связанную со складом';
    end if;

    -- Если валидная finance-запись уже существует, скрытая строка является дублем.
    v_existing_finance := null;
    select other.data into v_existing_finance
    from public.records other
    where other.entity = 'finance'
      and other.id <> v_record.id
      and other.data ->> 'bankId' = v_bank_id
      and not (
        coalesce(length(other.data ->> 'businessId'), 0) > 0
        and coalesce(length(other.data ->> 'unit'), 0) > 0
        and other.data ->> 'businessId' <> other.data ->> 'unit'
      )
      and coalesce(
        nullif(other.data ->> 'businessId', ''),
        nullif(other.data ->> 'unit', ''),
        ''
      ) not in ('', 'all')
      and exists (
        select 1
        from public.records business
        where business.entity = 'businesses'
          and business.id = coalesce(
            nullif(other.data ->> 'businessId', ''),
            nullif(other.data ->> 'unit', '')
          )
      )
    order by other.id
    limit 1
    for update;
    if v_existing_finance is not null then
      delete from public.records where entity = 'finance' and id = v_record.id;
      v_existing_finance := null;
      continue;
    end if;

    v_existing_queue := null;
    select queued.data into v_existing_queue
    from public.records queued
    where queued.entity = 'bankTransactions'
      and queued.data ->> 'bankId' = v_bank_id
    order by queued.id
    limit 1
    for update;

    if v_existing_queue is null then
      execute format(
        'select encode(%I.digest(convert_to($1, ''UTF8''), ''sha256''), ''hex'')',
        v_pgcrypto_schema
      ) into v_queue_hash using v_bank_id;
      v_queue_id := 'bankq:' || v_queue_hash;
      v_queue_data := jsonb_build_object(
        'id', v_queue_id,
        'bankId', v_bank_id,
        'date', v_record.data -> 'date',
        'type', v_record.data -> 'type',
        'amount', v_record.data -> 'amount',
        'method', v_record.data -> 'method',
        'source', 'bank',
        'counterparty', v_record.data -> 'counterparty',
        'comment', v_record.data -> 'comment',
        'created', coalesce(v_record.data -> 'created', to_jsonb(v_now)),
        'updated', v_now
      );

      insert into public.records(entity, id, data)
      values ('bankTransactions', v_queue_id, v_queue_data)
      on conflict (entity, id) do nothing;

      select queued.data into v_existing_queue
      from public.records queued
      where queued.entity = 'bankTransactions' and queued.id = v_queue_id
      for update;
      if v_existing_queue is null or v_existing_queue ->> 'bankId' is distinct from v_bank_id then
        raise exception 'Не удалось безопасно восстановить банковскую операцию';
      end if;
    end if;

    delete from public.records where entity = 'finance' and id = v_record.id;
    v_existing_queue := null;
  end loop;
end;
$$;
