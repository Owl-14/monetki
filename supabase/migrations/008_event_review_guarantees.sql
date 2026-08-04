-- Гарантии ревью MON-005: атомарная уникальность, безопасное удаление и восстановление графа.

do $$
begin
  if exists (
    select 1 from public.records
    where entity = 'eventRegistrations'
    group by data->>'eventId', data->>'participantType', data->>'participantId'
    having count(*) > 1
  ) then
    raise exception 'Найдены дубли регистраций событий; миграция остановлена без изменения данных';
  end if;
end;
$$;

create unique index if not exists records_event_registration_participant_unique
on public.records ((data->>'eventId'), (data->>'participantType'), (data->>'participantId'))
where entity = 'eventRegistrations';

create unique index if not exists records_event_allocation_key_unique
on public.records ((data->>'businessId'), (data->>'idempotencyKey'))
where entity = 'eventFinanceAllocations';

create or replace function public.event_protect_records()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_entity text := case when tg_op = 'DELETE' then old.entity else new.entity end;
  v_item jsonb := case when tg_op = 'DELETE' then old.data else new.data end;
  v_event_id text;
  v_business text;
  v_event jsonb;
  v_rpc text := coalesce(current_setting('app.event_finance_rpc', true), '');
begin
  if tg_op <> 'INSERT' and old.entity = 'eventFinanceAllocations' then
    raise exception 'Финансовые распределения событий неизменяемы';
  end if;
  if tg_op = 'INSERT' and new.entity = 'eventFinanceAllocations' and v_rpc not in ('allocation', 'restore') then
    raise exception 'Финансовое распределение создаётся только атомарным действием';
  end if;

  if tg_op = 'DELETE' and old.entity = 'events' and v_rpc <> 'delete' then
    raise exception 'Событие удаляется только атомарным действием';
  end if;
  if tg_op <> 'INSERT' and old.entity = 'events' and old.data->>'settlementStatus' = 'closed' then
    raise exception 'Закрытый расчёт события нельзя изменить или удалить';
  end if;
  if tg_op = 'UPDATE' and old.entity = 'events'
      and old.data->>'settlementStatus' is distinct from 'closed'
      and new.data->>'settlementStatus' = 'closed' and v_rpc <> 'close' then
    raise exception 'Расчёт события закрывается только атомарным действием';
  end if;

  if v_entity = 'events' and tg_op in ('INSERT', 'UPDATE') then
    v_business := coalesce(v_item->>'businessId', v_item->>'unit', '');
    if v_business = '' or v_item->>'businessId' is distinct from v_business
        or v_item->>'unit' is distinct from v_business then
      raise exception 'businessId и unit должны совпадать';
    end if;
    if coalesce(v_item->>'venueId', '') <> '' then
      perform 1 from public.records
      where entity = 'venues' and id = v_item->>'venueId'
        and data->>'businessId' = v_business and data->>'unit' = v_business
      for share;
      if not found then raise exception 'Площадка не найдена в этом бизнесе'; end if;
    end if;
  end if;

  if tg_op <> 'INSERT' and old.entity = 'finance' and exists (
    select 1 from public.records where entity = 'eventFinanceAllocations' and data->>'financeId' = old.id
  ) then
    if tg_op = 'DELETE' then raise exception 'Связанную финансовую операцию нельзя удалить'; end if;
    if new.data->>'businessId' is distinct from old.data->>'businessId'
       or new.data->>'unit' is distinct from old.data->>'unit'
       or new.data->>'type' is distinct from old.data->>'type'
       or new.data->>'amount' is distinct from old.data->>'amount' then
      raise exception 'Нельзя изменить сумму, тип или бизнес связанной финансовой операции';
    end if;
  end if;

  if tg_op <> 'INSERT' and old.entity = 'eventRegistrations' and exists (
    select 1 from public.records where entity = 'eventFinanceAllocations' and data->>'registrationId' = old.id
  ) then
    if tg_op = 'DELETE' then raise exception 'Регистрацию со связанной оплатой нельзя удалить'; end if;
    if new.data->>'eventId' is distinct from old.data->>'eventId'
       or new.data->>'participantType' is distinct from old.data->>'participantType'
       or new.data->>'participantId' is distinct from old.data->>'participantId' then
      raise exception 'Нельзя изменить событие или участника регистрации со связанной оплатой';
    end if;
  end if;

  if tg_op <> 'INSERT' and old.entity = 'eventBudgetLines' and exists (
    select 1 from public.records where entity = 'eventFinanceAllocations' and data->>'budgetLineId' = old.id
  ) then
    if tg_op = 'DELETE' then raise exception 'Строку бюджета со связанной финансовой операцией нельзя удалить'; end if;
    if new.data->>'eventId' is distinct from old.data->>'eventId' then
      raise exception 'Нельзя перенести связанную строку бюджета в другое событие';
    end if;
  end if;

  if v_entity in ('eventRegistrations', 'eventBudgetLines', 'eventFinanceAllocations') then
    if tg_op = 'UPDATE' and old.data->>'eventId' is distinct from new.data->>'eventId' then
      raise exception 'Нельзя переносить запись между событиями';
    end if;
    v_event_id := v_item->>'eventId';
    v_business := coalesce(v_item->>'businessId', v_item->>'unit', '');
    if v_business = '' or v_item->>'businessId' is distinct from v_business
        or v_item->>'unit' is distinct from v_business then
      raise exception 'businessId и unit должны совпадать';
    end if;
    select data into v_event from public.records where entity = 'events' and id = v_event_id for update;
    if v_event is null then raise exception 'Родительское событие не найдено'; end if;
    if v_event->>'businessId' is distinct from v_business or v_event->>'unit' is distinct from v_business then
      raise exception 'Дочерняя запись не относится к бизнесу события';
    end if;
    if v_event->>'settlementStatus' = 'closed' and v_rpc <> 'restore' then
      raise exception 'Закрытый расчёт события нельзя изменять';
    end if;
    if v_entity = 'eventRegistrations' and tg_op in ('INSERT', 'UPDATE') and exists (
      select 1 from public.records
      where entity = 'eventRegistrations' and id <> new.id
        and data->>'eventId' = new.data->>'eventId'
        and data->>'participantType' = new.data->>'participantType'
        and data->>'participantId' = new.data->>'participantId'
    ) then
      raise exception 'Участник уже зарегистрирован на это событие';
    end if;
    if v_entity = 'eventRegistrations' and tg_op in ('INSERT', 'UPDATE') then
      perform 1 from public.records where entity = case new.data->>'participantType'
        when 'player' then 'players' when 'company' then 'companies' when 'contact' then 'contacts' else '' end
        and id = new.data->>'participantId'
        and data->>'businessId' = v_business and data->>'unit' = v_business for share;
      if not found then raise exception 'Участник не найден в этом бизнесе'; end if;
    end if;
  end if;

  if tg_op = 'DELETE' and old.entity in ('players', 'companies', 'contacts') and exists (
    select 1 from public.records
    where entity = 'eventRegistrations' and data->>'participantId' = old.id
      and data->>'participantType' = case old.entity
        when 'players' then 'player' when 'companies' then 'company' else 'contact' end
  ) then
    raise exception 'Участник используется в событии и должен остаться в истории';
  end if;
  if tg_op = 'DELETE' and old.entity = 'venues' and exists (
    select 1 from public.records where entity = 'events' and data->>'venueId' = old.id
  ) then
    raise exception 'Площадка используется в событии и должна остаться в истории';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function public.event_delete(p_expected jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id text := coalesce(p_expected->>'id', '');
  v_business text := coalesce(p_expected->>'businessId', p_expected->>'unit', '');
  v_business_row jsonb;
  v_event jsonb;
begin
  if v_id = '' or v_business = '' or p_expected->>'businessId' is distinct from v_business
      or p_expected->>'unit' is distinct from v_business then
    raise exception 'businessId и unit должны совпадать';
  end if;
  select data into v_business_row from public.records where entity = 'businesses' and id = v_business for update;
  if v_business_row is null or v_business_row->>'active' = 'false'
      or jsonb_typeof(v_business_row->'modules') <> 'array' or not (v_business_row->'modules' ? 'events') then
    raise exception 'Модуль «События» выключен для этого бизнеса';
  end if;
  select data into v_event from public.records where entity = 'events' and id = v_id for update;
  if v_event is null then raise exception 'Событие не найдено'; end if;
  if v_event->>'businessId' is distinct from v_business or v_event->>'unit' is distinct from v_business then
    raise exception 'Событие не найдено в этом бизнесе';
  end if;
  if v_event is distinct from p_expected then raise exception 'Событие уже изменено другим запросом'; end if;
  if v_event->>'status' = 'completed' or v_event->>'settlementStatus' = 'closed' then
    raise exception 'Завершённое событие нельзя удалить';
  end if;
  if exists (
    select 1 from public.records where entity in ('eventRegistrations', 'eventBudgetLines', 'eventFinanceAllocations')
      and data->>'eventId' = v_id
  ) then raise exception 'У события уже есть участники, бюджет или финансовая история'; end if;
  perform set_config('app.event_finance_rpc', 'delete', true);
  delete from public.records where entity = 'events' and id = v_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.event_restore_child(p_entity text, p_item jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id text := coalesce(p_item->>'id', '');
  v_business text := coalesce(p_item->>'businessId', p_item->>'unit', '');
  v_event_id text := coalesce(p_item->>'eventId', '');
  v_event jsonb;
  v_existing jsonb;
  v_participant_entity text;
  v_amount numeric;
begin
  if p_entity not in ('eventRegistrations', 'eventBudgetLines') then raise exception 'Нельзя восстановить эту сущность события'; end if;
  if v_id = '' or v_event_id = '' or v_business = ''
      or p_item->>'businessId' is distinct from v_business or p_item->>'unit' is distinct from v_business then
    raise exception 'businessId и unit должны совпадать';
  end if;
  perform 1 from public.records where entity = 'businesses' and id = v_business for update;
  if not found then raise exception 'Бизнес события не найден'; end if;
  select data into v_event from public.records where entity = 'events' and id = v_event_id for update;
  if v_event is null or v_event->>'businessId' is distinct from v_business or v_event->>'unit' is distinct from v_business then
    raise exception 'Событие не найдено в этом бизнесе';
  end if;
  select data into v_existing from public.records where entity = p_entity and id = v_id;
  if v_existing is not null then
    if v_existing is distinct from p_item then raise exception 'Резервная копия конфликтует с существующей историей события'; end if;
    return jsonb_build_object('ok', true, 'item', v_existing, 'alreadyRestored', true);
  end if;
  if p_entity = 'eventRegistrations' then
    if coalesce(p_item->>'status', '') not in ('registered', 'confirmed', 'attended', 'cancelled', 'refunded') then
      raise exception 'Неизвестный статус регистрации';
    end if;
    v_participant_entity := case p_item->>'participantType'
      when 'player' then 'players' when 'company' then 'companies' when 'contact' then 'contacts' else '' end;
    if v_participant_entity = '' or not exists (
      select 1 from public.records where entity = v_participant_entity and id = p_item->>'participantId'
        and data->>'businessId' = v_business and data->>'unit' = v_business
    ) then raise exception 'Участник не найден в этом бизнесе'; end if;
    begin v_amount := (p_item->>'chargeAmount')::numeric; exception when others then raise exception 'Начисление должно быть неотрицательным числом'; end;
    if v_amount is null or v_amount < 0 or v_amount <> round(v_amount, 2) then raise exception 'Некорректное начисление регистрации'; end if;
  else
    if coalesce(p_item->>'name', '') = '' or coalesce(p_item->>'direction', '') not in ('income', 'expense') then
      raise exception 'Некорректная строка бюджета';
    end if;
    begin v_amount := (p_item->>'plannedAmount')::numeric; exception when others then raise exception 'Плановая сумма должна быть неотрицательным числом'; end;
    if v_amount is null or v_amount < 0 or v_amount <> round(v_amount, 2) then raise exception 'Некорректная плановая сумма'; end if;
  end if;
  perform set_config('app.event_finance_rpc', 'restore', true);
  insert into public.records(entity, id, data) values (p_entity, v_id, p_item);
  return jsonb_build_object('ok', true, 'item', p_item);
end;
$$;

create or replace function public.event_allocate_finance(p_item jsonb, p_restore boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business text := coalesce(p_item->>'businessId', p_item->>'unit', '');
  v_event_id text := coalesce(p_item->>'eventId', '');
  v_finance_id text := coalesce(p_item->>'financeId', '');
  v_key text := coalesce(p_item->>'idempotencyKey', '');
  v_purpose text := coalesce(p_item->>'purpose', '');
  v_id text;
  v_business_row jsonb;
  v_event jsonb;
  v_finance jsonb;
  v_existing jsonb;
  v_amount numeric;
  v_allocated numeric;
begin
  if v_business = '' or p_item->>'businessId' is distinct from v_business or p_item->>'unit' is distinct from v_business then
    raise exception 'businessId и unit должны совпадать';
  end if;
  if v_event_id = '' or v_finance_id = '' then raise exception 'Не указано событие или финансовая операция'; end if;
  if v_key !~ '^[A-Za-z0-9:_-]{8,160}$' then raise exception 'Некорректный ключ повторяемости'; end if;
  if v_purpose not in ('payment', 'deposit', 'expense', 'refund') then raise exception 'Неизвестное назначение распределения'; end if;
  begin v_amount := (p_item->>'amount')::numeric; exception when others then raise exception 'Сумма распределения должна быть больше нуля'; end;
  if v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) then raise exception 'Некорректная сумма распределения'; end if;

  select data into v_business_row from public.records where entity = 'businesses' and id = v_business for update;
  if v_business_row is null then raise exception 'Бизнес события не найден'; end if;
  if not p_restore and (v_business_row->>'active' = 'false' or jsonb_typeof(v_business_row->'modules') <> 'array'
      or not (v_business_row->'modules' ? 'events')) then raise exception 'Модуль «События» выключен для этого бизнеса'; end if;

  select data into v_event from public.records where entity = 'events' and id = v_event_id for update;
  if v_event is null or v_event->>'businessId' is distinct from v_business or v_event->>'unit' is distinct from v_business then
    raise exception 'Событие не найдено в этом бизнесе';
  end if;
  if v_event->>'settlementStatus' = 'closed' and not p_restore then raise exception 'Закрытый расчёт события нельзя изменять'; end if;

  select data into v_finance from public.records where entity = 'finance' and id = v_finance_id for update;
  if v_finance is null or v_finance->>'businessId' is distinct from v_business or v_finance->>'unit' is distinct from v_business then
    raise exception 'Финансовая операция не найдена в этом бизнесе';
  end if;
  if v_purpose in ('payment', 'deposit') and v_finance->>'type' <> 'income' then raise exception 'Оплата или депозит должны ссылаться на приход'; end if;
  if v_purpose in ('expense', 'refund') and v_finance->>'type' <> 'expense' then raise exception 'Расход или возврат должны ссылаться на списание'; end if;

  if coalesce(p_item->>'registrationId', '') <> '' and not exists (
    select 1 from public.records where entity = 'eventRegistrations' and id = p_item->>'registrationId'
      and data->>'eventId' = v_event_id and data->>'businessId' = v_business and data->>'unit' = v_business
  ) then raise exception 'Регистрация не относится к этому событию';
  elsif coalesce(p_item->>'registrationId', '') = '' and v_purpose in ('payment', 'deposit', 'refund') then
    raise exception 'Для оплаты, депозита или возврата укажите регистрацию участника';
  end if;
  if coalesce(p_item->>'budgetLineId', '') <> '' and not exists (
    select 1 from public.records where entity = 'eventBudgetLines' and id = p_item->>'budgetLineId'
      and data->>'eventId' = v_event_id and data->>'businessId' = v_business and data->>'unit' = v_business
  ) then raise exception 'Строка бюджета не относится к этому событию'; end if;

  v_id := case when p_restore and coalesce(p_item->>'id', '') <> '' then p_item->>'id'
    else 'event-allocation:' || md5(v_business || ':' || v_key) end;
  p_item := jsonb_set(p_item, '{id}', to_jsonb(v_id), true);
  select data into v_existing from public.records where entity = 'eventFinanceAllocations'
    and data->>'businessId' = v_business and data->>'idempotencyKey' = v_key for update;
  if v_existing is not null then
    if (p_restore and (v_existing - 'id') is distinct from (p_item - 'id'))
       or (not p_restore and (v_existing->>'eventId' is distinct from v_event_id
         or v_existing->>'financeId' is distinct from v_finance_id
         or coalesce(v_existing->>'registrationId', '') is distinct from coalesce(p_item->>'registrationId', '')
         or coalesce(v_existing->>'budgetLineId', '') is distinct from coalesce(p_item->>'budgetLineId', '')
         or v_existing->>'purpose' is distinct from v_purpose
         or (v_existing->>'amount')::numeric is distinct from v_amount)) then
      raise exception 'Ключ повторяемости уже использован для другого распределения';
    end if;
    return jsonb_build_object('ok', true, 'item', v_existing, 'alreadyAllocated', true);
  end if;

  select coalesce(sum((data->>'amount')::numeric), 0) into v_allocated
  from public.records where entity = 'eventFinanceAllocations' and data->>'financeId' = v_finance_id;
  if round(v_allocated * 100)::bigint + round(v_amount * 100)::bigint
      > round(coalesce((v_finance->>'amount')::numeric, 0) * 100)::bigint then
    raise exception 'Нельзя распределить больше суммы финансовой операции';
  end if;
  perform set_config('app.event_finance_rpc', case when p_restore then 'restore' else 'allocation' end, true);
  insert into public.records(entity, id, data) values ('eventFinanceAllocations', v_id, p_item);
  return jsonb_build_object('ok', true, 'item', p_item);
exception when unique_violation then
  select data into v_existing from public.records where entity = 'eventFinanceAllocations'
    and data->>'businessId' = v_business and data->>'idempotencyKey' = v_key;
  if v_existing is null or (p_restore and (v_existing - 'id') is distinct from (p_item - 'id'))
      or (not p_restore and (v_existing->>'eventId' is distinct from v_event_id
        or v_existing->>'financeId' is distinct from v_finance_id
        or coalesce(v_existing->>'registrationId', '') is distinct from coalesce(p_item->>'registrationId', '')
        or coalesce(v_existing->>'budgetLineId', '') is distinct from coalesce(p_item->>'budgetLineId', '')
        or v_existing->>'purpose' is distinct from v_purpose
        or (v_existing->>'amount')::numeric is distinct from v_amount)) then
    raise exception 'Ключ повторяемости уже использован для другого распределения';
  end if;
  return jsonb_build_object('ok', true, 'item', v_existing, 'alreadyAllocated', true);
end;
$$;

create or replace function public.event_restore_graph(p_graph jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entity text;
  v_item jsonb;
  v_existing jsonb;
  v_business text;
  v_count integer := 0;
begin
  if p_graph is null or jsonb_typeof(p_graph) <> 'object' then raise exception 'Некорректный граф событий'; end if;
  perform pg_advisory_xact_lock(hashtext('event_restore_graph'));
  foreach v_entity in array array['eventTypes', 'events'] loop
    if jsonb_typeof(coalesce(p_graph->v_entity, '[]'::jsonb)) <> 'array' then raise exception 'Некорректный раздел резервной копии'; end if;
    for v_item in select value from jsonb_array_elements(coalesce(p_graph->v_entity, '[]'::jsonb)) loop
      v_business := coalesce(v_item->>'businessId', v_item->>'unit', '');
      if coalesce(v_item->>'id', '') = '' or v_business = ''
          or v_item->>'businessId' is distinct from v_business or v_item->>'unit' is distinct from v_business then
        raise exception 'businessId и unit должны совпадать';
      end if;
      perform 1 from public.records where entity = 'businesses' and id = v_business for update;
      if not found then raise exception 'Бизнес события не найден'; end if;
      if v_entity = 'events' then
        if not exists (select 1 from public.records where entity = 'eventTypes' and id = v_item->>'eventTypeId'
          and data->>'businessId' = v_business and data->>'unit' = v_business) then
          raise exception 'Тип события не относится к бизнесу события';
        end if;
        if coalesce(v_item->>'venueId', '') <> '' and not exists (
          select 1 from public.records where entity = 'venues' and id = v_item->>'venueId'
            and data->>'businessId' = v_business and data->>'unit' = v_business
        ) then raise exception 'Площадка не относится к бизнесу события'; end if;
      end if;
      select data into v_existing from public.records where entity = v_entity and id = v_item->>'id';
      if v_existing is not null and v_existing is distinct from v_item then
        raise exception 'Резервная копия конфликтует с существующей историей события';
      end if;
      if v_existing is null then
        perform set_config('app.event_finance_rpc', 'restore', true);
        insert into public.records(entity, id, data) values (v_entity, v_item->>'id', v_item);
      end if;
      v_count := v_count + 1;
    end loop;
  end loop;
  foreach v_entity in array array['eventRegistrations', 'eventBudgetLines'] loop
    if jsonb_typeof(coalesce(p_graph->v_entity, '[]'::jsonb)) <> 'array' then raise exception 'Некорректный раздел резервной копии'; end if;
    for v_item in select value from jsonb_array_elements(coalesce(p_graph->v_entity, '[]'::jsonb)) loop
      perform public.event_restore_child(v_entity, v_item);
      v_count := v_count + 1;
    end loop;
  end loop;
  if jsonb_typeof(coalesce(p_graph->'eventFinanceAllocations', '[]'::jsonb)) <> 'array' then
    raise exception 'Некорректный раздел резервной копии';
  end if;
  for v_item in select value from jsonb_array_elements(coalesce(p_graph->'eventFinanceAllocations', '[]'::jsonb)) loop
    perform public.event_allocate_finance(v_item, true);
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('ok', true, 'restored', v_count);
end;
$$;

revoke all on function public.event_delete(jsonb) from public, anon, authenticated;
revoke all on function public.event_restore_graph(jsonb) from public, anon, authenticated;
revoke all on function public.event_restore_child(text, jsonb) from public, anon, authenticated;
revoke all on function public.event_allocate_finance(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.event_delete(jsonb) to service_role;
grant execute on function public.event_restore_graph(jsonb) to service_role;
grant execute on function public.event_restore_child(text, jsonb) to service_role;
grant execute on function public.event_allocate_finance(jsonb, boolean) to service_role;

notify pgrst, 'reload schema';
