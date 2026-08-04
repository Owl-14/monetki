-- Атомарные распределения денег и закрытие расчётов событий.
-- Факт денег остаётся в finance; eventFinanceAllocations хранит только неизменяемую связь.

create or replace function public.event_protect_records()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_event_id text;
  v_event jsonb;
  v_rpc text := coalesce(current_setting('app.event_finance_rpc', true), '');
begin
  if tg_op <> 'INSERT' and old.entity = 'eventFinanceAllocations' then
    raise exception 'Финансовые распределения событий неизменяемы';
  end if;
  if tg_op = 'INSERT' and new.entity = 'eventFinanceAllocations' and v_rpc not in ('allocation', 'restore') then
    raise exception 'Финансовое распределение создаётся только атомарным действием';
  end if;

  if tg_op <> 'INSERT' and old.entity = 'finance' and exists (
    select 1 from public.records
    where entity = 'eventFinanceAllocations' and data->>'financeId' = old.id
  ) then
    if tg_op = 'DELETE' then
      raise exception 'Связанную финансовую операцию нельзя удалить';
    end if;
    if coalesce(new.data->>'businessId', new.data->>'unit', '')
         is distinct from coalesce(old.data->>'businessId', old.data->>'unit', '')
       or new.data->>'type' is distinct from old.data->>'type'
       or new.data->>'amount' is distinct from old.data->>'amount' then
      raise exception 'Нельзя изменить сумму, тип или бизнес связанной финансовой операции';
    end if;
  end if;

  if tg_op <> 'INSERT' and old.entity = 'eventRegistrations' and exists (
    select 1 from public.records
    where entity = 'eventFinanceAllocations' and data->>'registrationId' = old.id
  ) then
    if tg_op = 'DELETE' then
      raise exception 'Регистрацию со связанной оплатой нельзя удалить';
    end if;
    if new.data->>'eventId' is distinct from old.data->>'eventId'
       or new.data->>'participantType' is distinct from old.data->>'participantType'
       or new.data->>'participantId' is distinct from old.data->>'participantId' then
      raise exception 'Нельзя изменить событие или участника регистрации со связанной оплатой';
    end if;
  end if;

  if tg_op <> 'INSERT' and old.entity = 'eventBudgetLines' and exists (
    select 1 from public.records
    where entity = 'eventFinanceAllocations' and data->>'budgetLineId' = old.id
  ) then
    if tg_op = 'DELETE' then
      raise exception 'Строку бюджета со связанной финансовой операцией нельзя удалить';
    end if;
    if new.data->>'eventId' is distinct from old.data->>'eventId' then
      raise exception 'Нельзя перенести связанную строку бюджета в другое событие';
    end if;
  end if;

  if tg_op <> 'INSERT' and old.entity = 'events' and old.data->>'settlementStatus' = 'closed' then
    raise exception 'Закрытый расчёт события нельзя изменить или удалить';
  end if;
  if tg_op = 'UPDATE' and old.entity = 'events'
      and old.data->>'settlementStatus' is distinct from 'closed'
      and new.data->>'settlementStatus' = 'closed' and v_rpc <> 'close' then
    raise exception 'Расчёт события закрывается только атомарным действием';
  end if;

  if coalesce(case when tg_op = 'DELETE' then old.entity else new.entity end, '')
      in ('eventRegistrations', 'eventBudgetLines', 'eventFinanceAllocations') then
    if tg_op = 'UPDATE' and old.data->>'eventId' is distinct from new.data->>'eventId' then
      raise exception 'Нельзя переносить запись между событиями';
    end if;
    v_event_id := case when tg_op in ('DELETE', 'UPDATE') then old.data->>'eventId' else new.data->>'eventId' end;
    select data into v_event from public.records where entity = 'events' and id = v_event_id for update;
    if v_event->>'settlementStatus' = 'closed' and v_rpc <> 'restore' then
      raise exception 'Закрытый расчёт события нельзя изменять';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists event_protect_records_trigger on public.records;
create trigger event_protect_records_trigger
before insert or update or delete on public.records
for each row execute function public.event_protect_records();

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
  v_inserted integer;
begin
  if v_business = '' or p_item->>'businessId' is distinct from v_business
      or p_item->>'unit' is distinct from v_business then
    raise exception 'businessId и unit должны совпадать';
  end if;
  if v_event_id = '' or v_finance_id = '' then raise exception 'Не указано событие или финансовая операция'; end if;
  if v_key !~ '^[A-Za-z0-9:_-]{8,160}$' then raise exception 'Некорректный ключ повторяемости'; end if;
  if v_purpose not in ('payment', 'deposit', 'expense', 'refund') then raise exception 'Неизвестное назначение распределения'; end if;
  begin v_amount := (p_item->>'amount')::numeric;
  exception when others then raise exception 'Сумма распределения должна быть больше нуля'; end;
  if v_amount is null or v_amount <= 0 then raise exception 'Сумма распределения должна быть больше нуля'; end if;
  if v_amount <> round(v_amount, 2) then raise exception 'Сумма распределения указывается с точностью до копеек'; end if;

  select data into v_business_row from public.records
  where entity = 'businesses' and id = v_business for update;
  if v_business_row is null or v_business_row->>'active' = 'false'
      or jsonb_typeof(v_business_row->'modules') <> 'array'
      or not (v_business_row->'modules' ? 'events') then
    raise exception 'Модуль «События» выключен для этого бизнеса';
  end if;

  select data into v_event from public.records
  where entity = 'events' and id = v_event_id for update;
  if v_event is null or coalesce(v_event->>'businessId', v_event->>'unit', '') <> v_business then
    raise exception 'Событие не найдено в этом бизнесе';
  end if;
  if v_event->>'settlementStatus' = 'closed' and not p_restore then raise exception 'Закрытый расчёт события нельзя изменять'; end if;

  v_id := 'event-allocation:' || md5(v_business || ':' || v_key);
  select data into v_existing from public.records
  where entity = 'eventFinanceAllocations' and id = v_id;
  if v_existing is not null then
    if v_existing->>'eventId' is distinct from v_event_id
       or v_existing->>'financeId' is distinct from v_finance_id
       or coalesce(v_existing->>'registrationId', '') is distinct from coalesce(p_item->>'registrationId', '')
       or coalesce(v_existing->>'budgetLineId', '') is distinct from coalesce(p_item->>'budgetLineId', '')
       or v_existing->>'purpose' is distinct from v_purpose
       or (v_existing->>'amount')::numeric is distinct from v_amount then
      raise exception 'Ключ повторяемости уже использован для другого распределения';
    end if;
    return jsonb_build_object('ok', true, 'item', v_existing, 'alreadyAllocated', true);
  end if;

  if coalesce(p_item->>'registrationId', '') <> '' then
    perform 1 from public.records where entity = 'eventRegistrations' and id = p_item->>'registrationId' for update;
    if not exists (
      select 1 from public.records where entity = 'eventRegistrations' and id = p_item->>'registrationId'
        and data->>'eventId' = v_event_id and coalesce(data->>'businessId', data->>'unit', '') = v_business
    ) then raise exception 'Регистрация не относится к этому событию'; end if;
  elsif v_purpose in ('payment', 'deposit', 'refund') then
    raise exception 'Для оплаты, депозита или возврата укажите регистрацию участника';
  end if;
  if coalesce(p_item->>'budgetLineId', '') <> '' then
    perform 1 from public.records where entity = 'eventBudgetLines' and id = p_item->>'budgetLineId' for update;
    if not exists (
      select 1 from public.records where entity = 'eventBudgetLines' and id = p_item->>'budgetLineId'
        and data->>'eventId' = v_event_id and coalesce(data->>'businessId', data->>'unit', '') = v_business
    ) then raise exception 'Строка бюджета не относится к этому событию'; end if;
  end if;

  select data into v_finance from public.records
  where entity = 'finance' and id = v_finance_id for update;
  if v_finance is null or coalesce(v_finance->>'businessId', v_finance->>'unit', '') <> v_business then
    raise exception 'Финансовая операция не найдена в этом бизнесе';
  end if;
  if v_purpose in ('payment', 'deposit') and v_finance->>'type' <> 'income' then
    raise exception 'Оплата или депозит должны ссылаться на приход';
  end if;
  if v_purpose in ('expense', 'refund') and v_finance->>'type' <> 'expense' then
    raise exception 'Расход или возврат должны ссылаться на списание';
  end if;

  select coalesce(sum((data->>'amount')::numeric), 0) into v_allocated
  from public.records where entity = 'eventFinanceAllocations' and data->>'financeId' = v_finance_id;
  if round(v_allocated * 100)::bigint + round(v_amount * 100)::bigint
      > round(coalesce((v_finance->>'amount')::numeric, 0) * 100)::bigint then
    raise exception 'Нельзя распределить больше суммы финансовой операции';
  end if;

  p_item := jsonb_set(p_item, '{id}', to_jsonb(v_id), true);
  perform set_config('app.event_finance_rpc', case when p_restore then 'restore' else 'allocation' end, true);
  insert into public.records(entity, id, data)
  values ('eventFinanceAllocations', v_id, p_item)
  on conflict (entity, id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    select data into strict v_existing from public.records where entity = 'eventFinanceAllocations' and id = v_id;
    if v_existing->>'eventId' is distinct from v_event_id
       or v_existing->>'financeId' is distinct from v_finance_id
       or coalesce(v_existing->>'registrationId', '') is distinct from coalesce(p_item->>'registrationId', '')
       or coalesce(v_existing->>'budgetLineId', '') is distinct from coalesce(p_item->>'budgetLineId', '')
       or v_existing->>'purpose' is distinct from v_purpose
       or (v_existing->>'amount')::numeric is distinct from v_amount then
      raise exception 'Ключ повторяемости уже использован для другого распределения';
    end if;
    return jsonb_build_object('ok', true, 'item', v_existing, 'alreadyAllocated', true);
  end if;
  return jsonb_build_object('ok', true, 'item', p_item);
end;
$$;

-- Восстановление валидной резервной копии сохраняет дочерние строки закрытых событий,
-- но остаётся недоступным клиентским ролям и не позволяет переписать существующую историю.
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
  v_business_row jsonb;
  v_event jsonb;
  v_existing jsonb;
  v_participant_entity text;
  v_amount numeric;
begin
  if p_entity not in ('eventRegistrations', 'eventBudgetLines') then raise exception 'Нельзя восстановить эту сущность события'; end if;
  if v_id = '' or v_event_id = '' then raise exception 'Не указана запись или событие'; end if;
  if v_business = '' or p_item->>'businessId' is distinct from v_business
      or p_item->>'unit' is distinct from v_business then
    raise exception 'businessId и unit должны совпадать';
  end if;
  select data into v_business_row from public.records where entity = 'businesses' and id = v_business for update;
  if v_business_row is null or jsonb_typeof(v_business_row->'modules') <> 'array'
      or not (v_business_row->'modules' ? 'events') then raise exception 'Модуль «События» выключен для этого бизнеса'; end if;
  select data into v_event from public.records where entity = 'events' and id = v_event_id for update;
  if v_event is null or coalesce(v_event->>'businessId', v_event->>'unit', '') <> v_business then
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
        and coalesce(data->>'businessId', data->>'unit', '') = v_business
    ) then raise exception 'Участник не найден в этом бизнесе'; end if;
    if exists (
      select 1 from public.records where entity = 'eventRegistrations' and data->>'eventId' = v_event_id
        and data->>'participantType' = p_item->>'participantType' and data->>'participantId' = p_item->>'participantId'
    ) then raise exception 'Участник уже зарегистрирован на это событие'; end if;
    begin v_amount := (p_item->>'chargeAmount')::numeric;
    exception when others then raise exception 'Начисление должно быть неотрицательным числом'; end;
    if v_amount is null or v_amount < 0 then raise exception 'Начисление должно быть неотрицательным числом'; end if;
    if v_amount <> round(v_amount, 2) then raise exception 'Денежные суммы указываются с точностью до копеек'; end if;
  else
    if coalesce(p_item->>'name', '') = '' or coalesce(p_item->>'direction', '') not in ('income', 'expense') then
      raise exception 'Некорректная строка бюджета';
    end if;
    begin v_amount := (p_item->>'plannedAmount')::numeric;
    exception when others then raise exception 'Плановая сумма должна быть неотрицательным числом'; end;
    if v_amount is null or v_amount < 0 then raise exception 'Плановая сумма должна быть неотрицательным числом'; end if;
    if v_amount <> round(v_amount, 2) then raise exception 'Денежные суммы указываются с точностью до копеек'; end if;
  end if;
  perform set_config('app.event_finance_rpc', 'restore', true);
  insert into public.records(entity, id, data) values (p_entity, v_id, p_item);
  return jsonb_build_object('ok', true, 'item', p_item);
end;
$$;

create or replace function public.event_close_settlement(p_expected jsonb, p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id text := coalesce(p_expected->>'id', '');
  v_business text;
  v_business_row jsonb;
  v_event jsonb;
  v_type jsonb;
  v_shares jsonb;
  v_owner_shares jsonb;
  v_history jsonb;
  v_settlement jsonb;
  v_now bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_count integer := 0;
  v_planned_income_count integer := 0;
  v_accrued numeric := 0;
  v_deposit numeric := 0;
  v_income numeric := 0;
  v_expenses numeric := 0;
  v_refunds numeric := 0;
  v_planned_income numeric := 0;
  v_planned_expenses numeric := 0;
  v_planned_profit numeric := 0;
  v_profit numeric := 0;
  v_paid numeric := 0;
begin
  if v_id = '' then raise exception 'Не указано событие'; end if;
  select data into v_event from public.records where entity = 'events' and id = v_id;
  if v_event is null then raise exception 'Событие не найдено'; end if;
  v_business := coalesce(v_event->>'businessId', v_event->>'unit', '');
  select data into v_business_row from public.records where entity = 'businesses' and id = v_business for update;
  if v_business_row is null or v_business_row->>'active' = 'false'
      or jsonb_typeof(v_business_row->'modules') <> 'array'
      or not (v_business_row->'modules' ? 'events') then
    raise exception 'Модуль «События» выключен для этого бизнеса';
  end if;
  select data into v_event from public.records where entity = 'events' and id = v_id for update;
  if v_event is null or coalesce(v_event->>'businessId', v_event->>'unit', '') <> v_business then
    raise exception 'Событие не найдено в этом бизнесе';
  end if;
  if v_event->>'settlementStatus' = 'closed' then
    return jsonb_build_object('ok', true, 'item', v_event, 'alreadyClosed', true);
  end if;
  if v_event is distinct from p_expected then raise exception 'Событие уже изменено другим запросом'; end if;
  if coalesce(v_event->>'status', '') not in ('completed', 'cancelled') then
    raise exception 'Сначала завершите или отмените событие';
  end if;

  perform 1 from public.records
  where entity = 'finance' and id in (
    select data->>'financeId' from public.records
    where entity = 'eventFinanceAllocations' and data->>'eventId' = v_id
  ) order by id for share;

  select count(*), coalesce(sum((data->>'chargeAmount')::numeric), 0)
  into v_count, v_accrued
  from public.records where entity = 'eventRegistrations' and data->>'eventId' = v_id
    and coalesce(data->>'status', '') not in ('cancelled', 'refunded');

  select
    coalesce(sum(case when f.data->>'type' = 'income' then (a.data->>'amount')::numeric else 0 end), 0),
    coalesce(sum(case when f.data->>'type' = 'income' and a.data->>'purpose' = 'deposit' then (a.data->>'amount')::numeric else 0 end), 0),
    coalesce(sum(case when f.data->>'type' = 'expense' and a.data->>'purpose' <> 'refund' then (a.data->>'amount')::numeric else 0 end), 0),
    coalesce(sum(case when f.data->>'type' = 'expense' and a.data->>'purpose' = 'refund' then (a.data->>'amount')::numeric else 0 end), 0)
  into v_income, v_deposit, v_expenses, v_refunds
  from public.records a join public.records f on f.entity = 'finance' and f.id = a.data->>'financeId'
  where a.entity = 'eventFinanceAllocations' and a.data->>'eventId' = v_id;

  select count(*) filter (where data->>'direction' = 'income'),
         coalesce(sum((data->>'plannedAmount')::numeric) filter (where data->>'direction' = 'income'), 0),
         coalesce(sum((data->>'plannedAmount')::numeric) filter (where data->>'direction' = 'expense'), 0)
  into v_planned_income_count, v_planned_income, v_planned_expenses
  from public.records where entity = 'eventBudgetLines' and data->>'eventId' = v_id;
  if v_planned_income_count = 0 then
    v_planned_income := coalesce((v_event->>'defaultFee')::numeric, 0) * coalesce((v_event->>'capacity')::numeric, 0);
  end if;
  v_paid := v_income;
  v_profit := v_income - v_expenses - v_refunds;
  v_planned_profit := v_planned_income - v_planned_expenses;

  select data into v_type from public.records where entity = 'eventTypes'
    and id = v_event->>'eventTypeId'
    and coalesce(data->>'businessId', data->>'unit', '') = v_business for share;
  if v_type is null then raise exception 'Тип события не найден в этом бизнесе'; end if;
  perform 1 from public.records where entity = 'businessOwners'
    and coalesce(data->>'businessId', data->>'unit', '') = v_business
    and data->>'active' is distinct from 'false' order by id for share;
  v_shares := case when jsonb_typeof(v_type->'ownerShares') = 'array' and jsonb_array_length(v_type->'ownerShares') > 0
    then v_type->'ownerShares' else null end;
  if v_shares is null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'ownerId', data->>'ownerId', 'name', coalesce(data->>'name', ''),
      'share', coalesce((data->>'share')::numeric, 0)
    ) order by data->>'ownerId'), '[]'::jsonb) into v_shares
    from public.records where entity = 'businessOwners'
      and coalesce(data->>'businessId', data->>'unit', '') = v_business
      and data->>'active' is distinct from 'false';
  end if;
  if jsonb_array_length(v_shares) = 0 or abs((
    select coalesce(sum((value->>'share')::numeric), 0) from jsonb_array_elements(v_shares)
  ) - 1) > 0.0001 then
    raise exception 'Настройте доли участников бизнеса: в сумме должно быть 100%%';
  end if;
  with share_rows as (
    select value, ordinality,
      count(*) over () as share_count,
      round(v_profit * coalesce((value->>'share')::numeric, 0), 2) as rounded_amount
    from jsonb_array_elements(v_shares) with ordinality
  ), distributed as (
    select value, ordinality, share_count, rounded_amount,
      coalesce(sum(rounded_amount) over (
        order by ordinality rows between unbounded preceding and 1 preceding
      ), 0) as prior_amount
    from share_rows
  )
  select coalesce(jsonb_agg(value || jsonb_build_object(
    'amount', case when ordinality = share_count
      then round(v_profit, 2) - prior_amount else rounded_amount end
  ) order by ordinality), '[]'::jsonb)
  into v_owner_shares from distributed;

  v_settlement := jsonb_build_object(
    'participantCount', v_count, 'accrued', v_accrued, 'depositApplied', v_deposit,
    'paid', v_paid, 'debt', greatest(0, v_accrued - v_paid), 'refunds', v_refunds,
    'plannedIncome', v_planned_income, 'plannedExpenses', v_planned_expenses,
    'plannedProfit', v_planned_profit,
    'plannedMargin', case when v_planned_income = 0 then null else v_planned_profit / v_planned_income end,
    'plannedProfitPerParticipant', case when coalesce((v_event->>'capacity')::numeric, 0) = 0 then null
      else v_planned_profit / (v_event->>'capacity')::numeric end,
    'actualIncome', v_income, 'directExpenses', v_expenses, 'profit', v_profit,
    'margin', case when v_income = 0 then null else v_profit / v_income end,
    'profitPerParticipant', case when v_count = 0 then null else v_profit / v_count end,
    'ownerShares', v_owner_shares, 'completedAt', v_now
  );
  v_history := coalesce(v_event->'history', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
    'id', 'event-history:' || md5(v_id || ':' || v_now::text), 'at', v_now,
    'byId', coalesce(p_user_id, ''), 'action', 'settlement_closed',
    'fromStatus', v_event->>'status', 'toStatus', v_event->>'status', 'changed', jsonb_build_array('settlementStatus')
  ));
  v_event := v_event || jsonb_build_object(
    'settlementStatus', 'closed', 'settlement', v_settlement,
    'settlementClosedAt', v_now, 'updated', v_now, 'history', v_history
  );
  perform set_config('app.event_finance_rpc', 'close', true);
  update public.records set data = v_event where entity = 'events' and id = v_id;
  return jsonb_build_object('ok', true, 'item', v_event);
end;
$$;

-- Одноразово включаем новый модуль для legacy-бизнеса Падел, не трогая другие настройки.
update public.records
set data = jsonb_set(data, '{modules}', coalesce(data->'modules', '[]'::jsonb) || '"events"'::jsonb, true)
where entity = 'businesses' and id = 'padel'
  and jsonb_typeof(data->'modules') = 'array' and not (data->'modules' ? 'events');

revoke all on function public.event_allocate_finance(jsonb, boolean) from public, anon, authenticated;
revoke all on function public.event_restore_child(text, jsonb) from public, anon, authenticated;
revoke all on function public.event_close_settlement(jsonb, text) from public, anon, authenticated;
revoke all on function public.event_protect_records() from public, anon, authenticated;
grant execute on function public.event_allocate_finance(jsonb, boolean) to service_role;
grant execute on function public.event_restore_child(text, jsonb) to service_role;
grant execute on function public.event_close_settlement(jsonb, text) to service_role;

notify pgrst, 'reload schema';
