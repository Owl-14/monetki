-- MON-010: безопасные правила необработанных банковских операций.
-- Все денежные изменения проходят через service_role RPC; raw payload банка не хранится.

do $$
begin
  if exists (
    select 1 from public.records where entity = 'finance' and coalesce(data->>'bankId', '') <> ''
    group by data->>'bankId' having count(*) > 1
  ) then raise exception 'Найдены дубли finance.bankId; миграция правил остановлена'; end if;
  if exists (
    select 1 from public.records where entity = 'bankTransactions' and coalesce(data->>'bankId', '') <> ''
    group by data->>'bankId' having count(*) > 1
  ) then raise exception 'Найдены дубли bankTransactions.bankId; миграция правил остановлена'; end if;
end;
$$;

create unique index if not exists records_finance_bank_id_unique
on public.records ((data->>'bankId')) where entity = 'finance' and coalesce(data->>'bankId', '') <> '';
create unique index if not exists records_bank_queue_bank_id_unique
on public.records ((data->>'bankId')) where entity = 'bankTransactions' and coalesce(data->>'bankId', '') <> '';
create unique index if not exists records_bank_rule_version_unique
on public.records ((data->>'ruleId'), ((data->>'version')::integer)) where entity = 'bankRuleVersions';
create unique index if not exists records_bank_rule_setting_version_unique
on public.records (((data->>'settingsVersion')::integer)) where entity = 'bankRuleSettingVersions';
create unique index if not exists records_bank_application_key_unique
on public.records ((data->>'idempotencyKey')) where entity = 'bankRuleApplications' and coalesce(data->>'idempotencyKey', '') <> '';
create unique index if not exists records_finance_relation_key_unique
on public.records ((data->>'idempotencyKey')) where entity = 'financeRelations' and coalesce(data->>'idempotencyKey', '') <> '';
create unique index if not exists records_finance_relation_unique
on public.records ((data->>'financeId'), (data->>'relationType'), (data->>'relationId')) where entity = 'financeRelations';

-- Повторный deploy сначала снимает trigger прошлой версии, иначе даже ON CONFLICT проходит его BEFORE INSERT.
drop trigger if exists bank_rules_protect_records_trigger on public.records;

insert into public.records(entity, id, data)
values ('bankRuleSettings', 'bank-rule-settings', jsonb_build_object(
  'id', 'bank-rule-settings', 'settingsVersion', 1, 'autoEnabled', false,
  'allowedDirections', jsonb_build_array('income', 'expense'),
  'maxAmountMinor', jsonb_build_object('income', 1000000, 'expense', 1000000),
  'maxTransactionsPerRun', 10, 'maxTransactionsPerDay', 20,
  'maxTotalAmountMinorPerDay', 5000000,
  'created', floor(extract(epoch from clock_timestamp()) * 1000),
  'updated', floor(extract(epoch from clock_timestamp()) * 1000)
)) on conflict (entity, id) do nothing;

insert into public.records(entity, id, data)
values ('bankRuleSettingVersions', 'bank-rule-settings:v1', jsonb_build_object(
  'id', 'bank-rule-settings:v1', 'settingsId', 'bank-rule-settings', 'settingsVersion', 1, 'autoEnabled', false,
  'allowedDirections', jsonb_build_array('income', 'expense'),
  'maxAmountMinor', jsonb_build_object('income', 1000000, 'expense', 1000000),
  'maxTransactionsPerRun', 10, 'maxTransactionsPerDay', 20, 'maxTotalAmountMinorPerDay', 5000000
)) on conflict (entity, id) do nothing;

-- Старые банковские finance могли быть созданы до появления журнала правил.
-- Создаём для них безопасную базовую запись аудита, чтобы классификацию можно
-- было исправлять только специальным RPC, не открывая generic CRUD.
insert into public.records(entity, id, data)
select 'bankRuleApplications', 'bank-application:legacy:' || md5(finance.id), jsonb_build_object(
  'id', 'bank-application:legacy:' || md5(finance.id),
  'idempotencyKey', 'legacy:' || md5(finance.id),
  'operation', 'legacy_backfill', 'decision', 'legacy', 'state', 'applied',
  'financeId', finance.id, 'financeFingerprint', md5(finance.data::text),
  'operationDate', finance.data->>'date', 'businessId', finance.data->>'businessId',
  'category', finance.data->>'category', 'method', finance.data->>'method',
  'auditRef', 'legacy-' || left(md5(finance.id), 8), 'canReverse', false,
  'actor', 'migration', 'created', case
    when coalesce(finance.data->>'updated', '') ~ '^[0-9]+$' then (finance.data->>'updated')::bigint
    when coalesce(finance.data->>'created', '') ~ '^[0-9]+$' then (finance.data->>'created')::bigint
    else 0 end
)
from public.records finance
where finance.entity = 'finance'
  and (coalesce(finance.data->>'source', '') = 'bank' or coalesce(finance.data->>'bankId', '') <> '')
  and not exists (
    select 1 from public.records application
    where application.entity = 'bankRuleApplications' and application.data->>'financeId' = finance.id
  )
on conflict (entity, id) do nothing;

create or replace function public.bank_rules_protect_records()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_entity text := case when tg_op = 'DELETE' then old.entity else new.entity end;
  v_mode text := coalesce(current_setting('app.bank_rules_rpc', true), '');
begin
  if v_entity in ('bankRuleVersions', 'bankRuleSettingVersions', 'bankRuleApplications', 'bankRuleRuns', 'financeRelations') then
    if tg_op <> 'INSERT' then raise exception 'История банковских правил неизменяема'; end if;
    if v_mode not in ('save', 'apply', 'queue_state', 'run', 'correct', 'reverse', 'restore') then
      raise exception 'Системная запись правил создаётся только атомарным действием';
    end if;
  end if;
  if v_entity in ('bankRules', 'bankRuleSettings') and v_mode not in ('save', 'restore') then
    raise exception 'Правила и настройки изменяются только версионным действием';
  end if;
  if v_entity = 'finance' and tg_op <> 'INSERT' and coalesce(old.data->>'applicationId', '') <> ''
      and v_mode not in ('correct', 'reverse', 'restore') then
    raise exception 'Операция, созданная правилом, изменяется только безопасным действием';
  end if;
  if v_entity = 'finance' and (
      coalesce((case when tg_op = 'DELETE' then old.data else new.data end)->>'source', '') = 'bank'
      or coalesce((case when tg_op = 'DELETE' then old.data else new.data end)->>'bankId', '') <> ''
      or (case when tg_op = 'DELETE' then old.data else new.data end) ?| array['bankQueueId', 'bankSignals', 'bankSignalFingerprint', 'bankOriginal', 'appliedRuleId', 'appliedRuleVersion', 'applicationId']
    ) and v_mode not in ('apply', 'correct', 'reverse', 'restore') then
    raise exception 'Банковская финансовая операция изменяется только атомарным действием';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists bank_rules_protect_records_trigger on public.records;
create trigger bank_rules_protect_records_trigger
before insert or update or delete on public.records
for each row execute function public.bank_rules_protect_records();

create or replace function public.bank_enqueue_transaction(p_item jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id text := coalesce(p_item->>'id', '');
  v_bank_id text := coalesce(p_item->>'bankId', '');
  v_existing jsonb;
  v_existing_id text;
  v_signal_amount bigint;
  v_visible_amount bigint;
  v_direction text;
begin
  if v_id = '' or length(v_id) > 128 or v_bank_id = '' or length(v_bank_id) > 300 then
    raise exception 'Некорректная банковская операция';
  end if;
  if jsonb_typeof(coalesce(p_item->'bankSignals', '{}'::jsonb)) <> 'object'
      or p_item ? 'raw' or p_item ? 'payload' or p_item ? 'token'
      or p_item->'bankSignals' ? 'raw' or p_item->'bankSignals' ? 'payload' or p_item->'bankSignals' ? 'token' then
    raise exception 'Запрещено сохранять сырой банковский ответ';
  end if;
  if exists (select 1 from jsonb_object_keys(coalesce(p_item->'bankSignals', '{}'::jsonb)) as keys(key)
      where key not in ('schemaVersion', 'direction', 'amountMinor', 'currency', 'detectedMethod', 'transactionTypeCode',
        'schemeName', 'sourceAccountKey', 'sender', 'recipient', 'descriptionNormalized', 'bankIdStrength'))
      or (coalesce(p_item->'bankSignals', '{}'::jsonb) <> '{}'::jsonb
        and coalesce((p_item->'bankSignals'->>'schemaVersion')::integer, 0) <> 1)
      or exists (select 1 from jsonb_object_keys(coalesce(p_item->'bankSignals'->'sender', '{}'::jsonb)) as keys(key)
        where key not in ('nameNormalized', 'phoneE164', 'inn', 'accountKey'))
      or exists (select 1 from jsonb_object_keys(coalesce(p_item->'bankSignals'->'recipient', '{}'::jsonb)) as keys(key)
        where key not in ('nameNormalized', 'phoneE164', 'inn', 'accountKey')) then
    raise exception 'bankSignals содержит неизвестные или ненормализованные поля';
  end if;
  if coalesce(p_item->'bankSignals', '{}'::jsonb) <> '{}'::jsonb then
    begin
      v_signal_amount := (p_item->'bankSignals'->>'amountMinor')::bigint;
      v_visible_amount := round((p_item->>'amount')::numeric * 100)::bigint;
      v_direction := p_item->'bankSignals'->>'direction';
    exception when others then
      raise exception 'bankSignals не согласован с банковской операцией';
    end;
    if v_signal_amount <= 0 or v_visible_amount <= 0 or v_signal_amount is distinct from v_visible_amount
        or v_direction not in ('income', 'expense') or p_item->>'type' is distinct from v_direction then
      raise exception 'bankSignals не согласован с банковской операцией';
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_bank_id, 0));
  select data into v_existing from public.records
  where entity = 'finance' and data->>'bankId' = v_bank_id for update;
  if v_existing is not null then return jsonb_build_object('ok', true, 'added', false, 'alreadyProcessed', true); end if;

  select id, data into v_existing_id, v_existing from public.records
  where entity = 'bankTransactions' and data->>'bankId' = v_bank_id for update;
  if v_existing is not null then
    if coalesce((v_existing->'bankSignals'->>'schemaVersion')::integer, 0) = 0
        and coalesce((p_item->'bankSignals'->>'schemaVersion')::integer, 0) > 0 then
      update public.records set data = v_existing
        || jsonb_build_object(
          'bankSignals', p_item->'bankSignals',
          'bankSignalFingerprint', p_item->>'bankSignalFingerprint',
          'updated', p_item->'updated'
        )
      where entity = 'bankTransactions' and id = v_existing_id;
      select data into v_existing from public.records where entity = 'bankTransactions' and id = v_existing_id;
      return jsonb_build_object('ok', true, 'added', false, 'enriched', true, 'item', v_existing - 'bankSignals' - 'bankId');
    end if;
    return jsonb_build_object('ok', true, 'added', false, 'duplicate', true, 'item', v_existing - 'bankSignals' - 'bankId');
  end if;
  insert into public.records(entity, id, data) values ('bankTransactions', v_id, p_item);
  return jsonb_build_object('ok', true, 'added', true, 'item', p_item - 'bankSignals' - 'bankId');
end;
$$;

create or replace function public.bank_rule_save(p_rule jsonb, p_expected_version integer, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id text := coalesce(p_rule->>'id', '');
  v_current jsonb;
  v_version integer;
  v_snapshot jsonb;
  v_run jsonb;
  v_settings jsonb;
begin
  if v_id !~ '^bank-rule:[A-Za-z0-9:_-]{3,150}$' or coalesce(p_rule->>'name', '') = ''
      or coalesce(p_rule->>'decision', '') not in ('suggest', 'auto', 'ignore', 'manual')
      or (p_rule->>'deleted' = 'true' and coalesce(p_rule->>'enabled', 'true') <> 'false') then
    raise exception 'Некорректное правило';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_id, 0));
  select data into v_current from public.records where entity = 'bankRules' and id = v_id for update;
  if coalesce((v_current->>'version')::integer, 0) <> coalesce(p_expected_version, 0) then
    raise exception 'Правило уже изменено';
  end if;
  if p_rule->>'decision' = 'auto' and coalesce((p_rule->>'enabled')::boolean, true) then
    select data into v_run from public.records where entity = 'bankRuleRuns' and id = p_rule->>'activationRunId';
    select data into v_settings from public.records where entity = 'bankRuleSettings' and id = 'bank-rule-settings';
    if v_run is null or v_run->>'kind' is distinct from 'dry-run'
        or v_run->>'actor' is distinct from p_actor
        or v_run->'activation'->>'ruleFingerprint' is distinct from p_rule->>'activationFingerprint'
        or coalesce((v_run->'activation'->>'expectedVersion')::integer, -1) <> coalesce(p_expected_version, 0)
        or coalesce((v_run->'activation'->>'settingsVersion')::integer, -1) <> coalesce((v_settings->>'settingsVersion')::integer, 0)
        or coalesce((v_run->'activation'->>'expiresAt')::bigint, 0) < floor(extract(epoch from clock_timestamp()) * 1000) then
      raise exception 'Auto-правило не подтверждено актуальной проверкой';
    end if;
  end if;
  if (v_current is null and coalesce(p_rule->>'createdBy', '') <> p_actor)
      or (v_current is not null and (p_rule->>'createdBy' is distinct from v_current->>'createdBy'
        or p_rule->'created' is distinct from v_current->'created')) then raise exception 'Нельзя подменить автора или дату создания правила'; end if;
  v_version := coalesce((v_current->>'version')::integer, 0) + 1;
  p_rule := p_rule || jsonb_build_object(
    'version', v_version, 'createdBy', coalesce(v_current->>'createdBy', p_actor),
    'created', coalesce(v_current->'created', to_jsonb(floor(extract(epoch from clock_timestamp()) * 1000))),
    'updatedBy', p_actor, 'updated', floor(extract(epoch from clock_timestamp()) * 1000)
  );
  v_snapshot := p_rule || jsonb_build_object('id', v_id || ':v' || v_version, 'ruleId', v_id);
  perform set_config('app.bank_rules_rpc', 'save', true);
  insert into public.records(entity, id, data) values ('bankRuleVersions', v_id || ':v' || v_version, v_snapshot);
  insert into public.records(entity, id, data) values ('bankRules', v_id, p_rule)
  on conflict (entity, id) do update set data = excluded.data;
  return jsonb_build_object('ok', true, 'rule', p_rule);
end;
$$;

drop function if exists public.bank_rule_settings_save(jsonb, integer);
create or replace function public.bank_rule_settings_save(p_settings jsonb, p_expected_version integer, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current jsonb;
  v_version integer;
begin
  select data into v_current from public.records
  where entity = 'bankRuleSettings' and id = 'bank-rule-settings' for update;
  if v_current is null or coalesce((v_current->>'settingsVersion')::integer, 0) <> p_expected_version then
    raise exception 'Настройки уже изменены';
  end if;
  if jsonb_typeof(p_settings->'allowedDirections') <> 'array'
      or jsonb_typeof(p_settings->'maxAmountMinor') <> 'object' then raise exception 'Некорректные настройки'; end if;
  if exists (select 1 from jsonb_array_elements_text(p_settings->'allowedDirections') direction
      where direction not in ('income', 'expense')) then raise exception 'Неизвестное направление автопроведения'; end if;
  if coalesce((p_settings->>'maxTransactionsPerRun')::integer, 0) < 0
      or coalesce((p_settings->>'maxTransactionsPerDay')::integer, 0) < 0
      or coalesce((p_settings->>'maxTotalAmountMinorPerDay')::bigint, 0) < 0
      or coalesce((p_settings->'maxAmountMinor'->>'income')::bigint, 0) < 0
      or coalesce((p_settings->'maxAmountMinor'->>'expense')::bigint, 0) < 0 then raise exception 'Лимиты не могут быть отрицательными'; end if;
  if coalesce((p_settings->>'autoEnabled')::boolean, false) and (
      jsonb_array_length(p_settings->'allowedDirections') = 0
      or coalesce((p_settings->>'maxTransactionsPerRun')::integer, 0) = 0
      or coalesce((p_settings->>'maxTransactionsPerDay')::integer, 0) = 0
      or coalesce((p_settings->>'maxTotalAmountMinorPerDay')::bigint, 0) = 0) then
    raise exception 'Перед включением автопроведения задайте безопасные лимиты';
  end if;
  v_version := p_expected_version + 1;
  p_settings := p_settings || jsonb_build_object(
    'id', 'bank-rule-settings', 'settingsVersion', v_version,
    'created', v_current->'created', 'updatedBy', p_actor,
    'updated', floor(extract(epoch from clock_timestamp()) * 1000)
  );
  perform set_config('app.bank_rules_rpc', 'save', true);
  insert into public.records(entity, id, data) values (
    'bankRuleSettingVersions', 'bank-rule-settings:v' || v_version,
    p_settings || jsonb_build_object('id', 'bank-rule-settings:v' || v_version, 'settingsId', 'bank-rule-settings')
  );
  update public.records set data = p_settings where entity = 'bankRuleSettings' and id = 'bank-rule-settings';
  return jsonb_build_object('ok', true, 'settings', p_settings);
end;
$$;

create or replace function public.bank_rule_append_run(p_run jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(p_run->>'id', '') = '' or jsonb_typeof(p_run->'summary') <> 'object'
      or p_run ? 'bankId' or p_run ? 'bankSignals' or p_run ? 'amount' then raise exception 'Некорректный итог запуска'; end if;
  perform set_config('app.bank_rules_rpc', 'run', true);
  insert into public.records(entity, id, data) values ('bankRuleRuns', p_run->>'id', p_run)
  on conflict (entity, id) do nothing;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.apply_bank_rule_transaction(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mode text := coalesce(p_payload->>'mode', '');
  v_queue_id text := coalesce(p_payload->>'queueId', '');
  v_bank_id text := coalesce(p_payload->>'bankId', '');
  v_key text := coalesce(p_payload->>'idempotencyKey', '');
  v_checksum text := coalesce(p_payload->>'requestChecksum', '');
  v_pending jsonb;
  v_existing jsonb;
  v_application jsonb := coalesce(p_payload->'application', '{}'::jsonb);
  v_finance jsonb := coalesce(p_payload->'finance', '{}'::jsonb);
  v_settings jsonb;
  v_rule jsonb;
  v_version jsonb;
  v_business jsonb;
  v_business_id text;
  v_finance_id text;
  v_amount_minor bigint;
  v_today text := to_char(clock_timestamp() at time zone 'Europe/Moscow', 'YYYY-MM-DD');
  v_count bigint;
  v_total bigint;
  v_relation jsonb;
  v_entity text;
  v_ref jsonb;
  v_company_id text;
  v_contact_id text;
  v_auto boolean := coalesce((p_payload->>'auto')::boolean, false);
  v_limit_failed boolean := false;
  v_unique_strong integer := 0;
  v_unique_context integer := 0;
  v_duplicate_evidence integer := 0;
begin
  if v_key !~ '^[A-Za-z0-9:_-]{8,160}$' or v_checksum = '' then raise exception 'Некорректный ключ повторяемости'; end if;
  perform pg_advisory_xact_lock(hashtextextended('bank-app:' || v_key, 0));
  select data into v_existing from public.records
  where entity = 'bankRuleApplications' and data->>'idempotencyKey' = v_key;
  if v_existing is not null then
    if v_existing->>'requestChecksum' is distinct from v_checksum then raise exception 'Ключ повторяемости использован для другого запроса'; end if;
    select data into v_finance from public.records where entity = 'finance' and id = v_existing->>'financeId';
    return jsonb_build_object('ok', true, 'item', v_finance, 'application', v_existing, 'alreadyProcessed', true, 'applied', v_existing->>'state' = 'applied');
  end if;
  if v_queue_id = '' or v_bank_id = '' then raise exception 'Не указана банковская операция'; end if;

  -- Один порядок во всех банковских RPC: advisory(bankId), затем row locks.
  perform pg_advisory_xact_lock(hashtextextended(v_bank_id, 0));
  select data into v_pending from public.records where entity = 'bankTransactions' and id = v_queue_id for update;
  if v_pending is null then raise exception 'Банковская операция не найдена'; end if;
  if v_pending->>'bankId' is distinct from v_bank_id
      or coalesce((v_pending->>'updated')::bigint, 0) <> coalesce((p_payload->>'expectedUpdated')::bigint, 0)
      or coalesce(v_pending->>'bankSignalFingerprint', p_payload->>'expectedFingerprint')
         is distinct from p_payload->>'expectedFingerprint' then raise exception 'Предложение устарело'; end if;
  if coalesce(v_pending->'bankSignals', '{}'::jsonb) <> '{}'::jsonb then
    begin
      v_amount_minor := (v_pending->'bankSignals'->>'amountMinor')::bigint;
    exception when others then
      raise exception 'bankSignals не согласован с банковской операцией';
    end;
    if v_amount_minor <= 0
        or v_amount_minor is distinct from round((v_pending->>'amount')::numeric * 100)::bigint
        or v_pending->'bankSignals'->>'direction' not in ('income', 'expense')
        or v_pending->>'type' is distinct from v_pending->'bankSignals'->>'direction' then
      raise exception 'bankSignals не согласован с банковской операцией';
    end if;
  end if;

  v_application := v_application || jsonb_build_object('requestChecksum', v_checksum);
  if v_mode = 'queue_state' then
    if coalesce(p_payload->>'queueState', '') not in ('pending', 'ignored', 'manual') then raise exception 'Неизвестное состояние очереди'; end if;
    update public.records set data = v_pending || jsonb_build_object(
      'bankRuleState', p_payload->>'queueState',
      'updated', floor(extract(epoch from clock_timestamp()) * 1000)
    ) where entity = 'bankTransactions' and id = v_queue_id;
    perform set_config('app.bank_rules_rpc', 'queue_state', true);
    insert into public.records(entity, id, data) values ('bankRuleApplications', v_application->>'id', v_application);
    return jsonb_build_object('ok', true, 'application', v_application, 'applied', false);
  end if;
  if v_mode <> 'apply' then raise exception 'Неизвестное действие банковского правила'; end if;
  if v_application->>'decision' = 'manual' then
    if coalesce(v_pending->>'bankRuleState', 'pending') not in ('pending', 'manual') then raise exception 'Сначала верните операцию к проверке'; end if;
  elsif coalesce(v_pending->>'bankRuleState', 'pending') <> 'pending' then
    raise exception 'Сначала верните операцию к проверке';
  end if;

  begin
    v_amount_minor := coalesce(
      (v_pending->'bankSignals'->>'amountMinor')::bigint,
      round(coalesce((v_pending->>'amount')::numeric, 0) * 100)::bigint
    );
  exception when others then
    v_amount_minor := round(coalesce((v_pending->>'amount')::numeric, 0) * 100)::bigint;
  end;
  if v_amount_minor is null or v_amount_minor <= 0 then raise exception 'Некорректная сумма операции'; end if;
  v_business_id := coalesce(v_finance->>'businessId', '');
  v_finance_id := coalesce(v_finance->>'id', '');
  if v_business_id = '' or v_finance->>'unit' is distinct from v_business_id or v_finance_id = '' then
    raise exception 'Некорректная финансовая операция';
  end if;

  if v_auto then
    select data into v_settings from public.records where entity = 'bankRuleSettings' and id = 'bank-rule-settings' for update;
    if v_settings is null or v_settings->>'autoEnabled' <> 'true'
        or (v_settings->>'settingsVersion')::integer is distinct from (v_application->>'settingsVersion')::integer
        or not (v_settings->'allowedDirections' ? (v_pending->>'type')) then v_limit_failed := true; end if;
    select data into v_rule from public.records where entity = 'bankRules' and id = v_application->>'appliedRuleId' for update;
    select data into v_version from public.records where entity = 'bankRuleVersions'
      and data->>'ruleId' = v_application->>'appliedRuleId'
      and (data->>'version')::integer = (v_application->>'appliedRuleVersion')::integer;
    with conditions as (
      select value from jsonb_array_elements(coalesce(v_rule->'conditions'->'all', '[]'::jsonb))
      union all select value from jsonb_array_elements(coalesce(v_rule->'conditions'->'any', '[]'::jsonb))
      union all select value from jsonb_array_elements(coalesce(v_rule->'conditions'->'none', '[]'::jsonb))
    ), evidence as (
      select value->>'field' as field,
        case
          when value->>'field' = 'sourceAccountKey' then 'source-account'
          when value->>'field' like 'sender.%' then 'sender'
          when value->>'field' like 'recipient.%' then 'recipient'
          when value->>'field' = 'descriptionNormalized' then 'description'
          when value->>'field' in ('schemeName', 'transactionTypeCode', 'detectedMethod') then 'payment-method'
          else value->>'field'
        end as family,
        case
          when value->>'field' in ('sourceAccountKey', 'sender.phoneE164', 'recipient.phoneE164', 'sender.inn', 'recipient.inn', 'sender.accountKey', 'recipient.accountKey')
            and value->>'op' = 'exact' then 'strong'
          when value->>'field' in ('sender.nameNormalized', 'recipient.nameNormalized', 'descriptionNormalized', 'schemeName', 'transactionTypeCode', 'currency') then 'context'
          else 'weak'
        end as kind
      from conditions
    )
    select count(distinct family) filter (where kind = 'strong'),
      count(distinct family) filter (where kind = 'context'),
      count(*) - count(distinct field) filter (where kind <> 'weak')
    into v_unique_strong, v_unique_context, v_duplicate_evidence
    from evidence where kind <> 'weak';
    if v_rule is null or v_version is null or v_rule->>'enabled' = 'false'
        or v_rule->>'decision' is distinct from 'auto' or v_version->>'decision' is distinct from 'auto'
        or v_application->>'decision' is distinct from 'auto' or v_application->>'requestedDecision' is distinct from 'auto'
        or (v_rule->>'version')::integer is distinct from (v_application->>'appliedRuleVersion')::integer
        or coalesce((v_application->>'confidence')::numeric, 0) < 0.95
        or coalesce((v_application->'explanation'->>'amountOnly')::boolean, false)
        or coalesce((v_application->'explanation'->>'conflict')::boolean, false)
        or coalesce((v_application->'explanation'->>'missingSignals')::integer, 0) > 0
        or coalesce((v_application->'explanation'->>'duplicateEvidenceCount')::integer, 0) > 0
        or v_duplicate_evidence > 0
        or coalesce((v_application->'explanation'->>'strongEvidenceCount')::integer, 0) > v_unique_strong
        or coalesce((v_application->'explanation'->>'contextEvidenceCount')::integer, 0) > v_unique_context
        or (coalesce((v_application->'explanation'->>'strongEvidenceCount')::integer, 0) < 1
          and coalesce((v_application->'explanation'->>'contextEvidenceCount')::integer, 0) < 2) then v_limit_failed := true; end if;
    if not v_limit_failed then
      if v_amount_minor > coalesce((v_settings->'maxAmountMinor'->>(v_pending->>'type'))::bigint, 0)
          or v_amount_minor > coalesce((v_rule->'autoLimits'->>'maxAmountMinor')::bigint, 9223372036854775807) then v_limit_failed := true; end if;
      select count(*), coalesce(sum((data->>'amountMinor')::bigint), 0) into v_count, v_total
      from public.records where entity = 'bankRuleApplications' and data->>'state' = 'applied'
        and data->>'decision' = 'auto' and data->>'day' = v_today;
      if v_count >= coalesce((v_settings->>'maxTransactionsPerDay')::bigint, 0)
          or v_total + v_amount_minor > coalesce((v_settings->>'maxTotalAmountMinorPerDay')::bigint, 0) then v_limit_failed := true; end if;
      if coalesce(p_payload->>'runId', '') <> '' then
        perform pg_advisory_xact_lock(hashtextextended('bank-run:' || p_payload->>'runId', 0));
        select count(*) into v_count from public.records where entity = 'bankRuleApplications'
          and data->>'state' = 'applied' and data->>'decision' = 'auto' and data->>'runId' = p_payload->>'runId';
        if v_count >= coalesce((v_settings->>'maxTransactionsPerRun')::bigint, 0) then v_limit_failed := true; end if;
      end if;
      select count(*) into v_count from public.records where entity = 'bankRuleApplications'
        and data->>'state' = 'applied' and data->>'decision' = 'auto' and data->>'day' = v_today
        and data->>'appliedRuleId' = v_application->>'appliedRuleId';
      if v_count >= coalesce((v_rule->'autoLimits'->>'maxTransactionsPerDay')::bigint, 9223372036854775807) then v_limit_failed := true; end if;
    end if;
    if v_limit_failed then
      v_application := v_application || jsonb_build_object('state', 'downgraded', 'decision', 'suggest', 'amountMinor', v_amount_minor, 'day', v_today);
      perform set_config('app.bank_rules_rpc', 'apply', true);
      insert into public.records(entity, id, data) values ('bankRuleApplications', v_application->>'id', v_application);
      return jsonb_build_object('ok', true, 'applied', false, 'downgraded', true, 'application', v_application);
    end if;
  elsif coalesce(v_application->>'appliedRuleId', '') <> '' then
    select data into v_rule from public.records where entity = 'bankRules' and id = v_application->>'appliedRuleId' for update;
    if v_rule is null or v_rule->>'enabled' = 'false'
        or (v_rule->>'version')::integer is distinct from (v_application->>'appliedRuleVersion')::integer then
      raise exception 'Предложение правила устарело';
    end if;
  end if;

  select data into v_business from public.records where entity = 'businesses' and id = v_business_id for update;
  if v_business is null or v_business->>'active' = 'false' then raise exception 'Бизнес не найден или находится в архиве'; end if;
  if coalesce(v_finance->>'owner', '') <> '' and not exists (
    select 1 from public.records where entity = 'businessOwners' and data->>'businessId' = v_business_id
      and data->>'unit' = v_business_id and data->>'ownerId' = v_finance->>'owner' and coalesce(data->>'active', 'true') <> 'false'
  ) then raise exception 'Владелец не относится к бизнесу'; end if;

  select data into v_existing from public.records where entity = 'finance' and data->>'bankId' = v_bank_id for update;
  if v_existing is not null then
    v_application := v_application || jsonb_build_object('state', 'already_processed', 'financeId', v_existing->>'id', 'amountMinor', v_amount_minor, 'day', v_today);
    perform set_config('app.bank_rules_rpc', 'apply', true);
    insert into public.records(entity, id, data) values ('bankRuleApplications', v_application->>'id', v_application);
    delete from public.records where entity = 'bankTransactions' and id = v_queue_id;
    return jsonb_build_object('ok', true, 'item', v_existing, 'application', v_application, 'alreadyProcessed', true, 'applied', false);
  end if;

  v_finance := v_finance || jsonb_build_object(
    'id', v_finance_id, 'businessId', v_business_id, 'unit', v_business_id,
    'date', left(coalesce(v_pending->>'date', current_date::text), 10),
    'type', case when v_pending->>'type' = 'income' then 'income' else 'expense' end,
    'amount', v_amount_minor::numeric / 100, 'source', 'bank', 'bankId', v_bank_id,
    'bankQueueId', v_queue_id, 'bankSignals', coalesce(v_pending->'bankSignals', '{}'::jsonb)
  );
  perform set_config('app.bank_rules_rpc', 'apply', true);
  insert into public.records(entity, id, data) values ('finance', v_finance_id, v_finance);

  select value->>'relationId' into v_company_id from jsonb_array_elements(coalesce(p_payload->'relations', '[]'::jsonb))
    where value->>'relationType' = 'company' limit 1;
  select value->>'relationId' into v_contact_id from jsonb_array_elements(coalesce(p_payload->'relations', '[]'::jsonb))
    where value->>'relationType' = 'contact' limit 1;
  for v_relation in select value from jsonb_array_elements(coalesce(p_payload->'relations', '[]'::jsonb)) loop
    if v_relation->>'financeId' is distinct from v_finance_id
        or v_relation->>'businessId' is distinct from v_business_id
        or v_relation->>'unit' is distinct from v_business_id
        or v_relation->>'applicationId' is distinct from v_application->>'id'
        or left(coalesce(v_relation->>'idempotencyKey', ''), length(v_key) + 1) is distinct from v_key || ':' then
      raise exception 'Финансовая связь не относится к текущему применению правила';
    end if;
    v_entity := case v_relation->>'relationType'
      when 'player' then 'players' when 'company' then 'companies' when 'contact' then 'contacts' when 'deal' then 'deals' else '' end;
    if v_entity = '' then raise exception 'Неизвестный тип финансовой связи'; end if;
    select data into v_ref from public.records where entity = v_entity and id = v_relation->>'relationId' for share;
    if v_ref is null or v_ref->>'businessId' is distinct from v_business_id or v_ref->>'unit' is distinct from v_business_id then
      raise exception 'Связанная запись не относится к бизнесу';
    end if;
    if v_relation->>'relationType' = 'contact' and coalesce(v_company_id, '') <> ''
        and v_ref->>'companyId' is distinct from v_company_id then raise exception 'Контакт не относится к выбранной компании'; end if;
    if v_relation->>'relationType' = 'deal' and (
        (coalesce(v_company_id, '') <> '' and coalesce(v_ref->>'companyId', '') <> '' and v_ref->>'companyId' is distinct from v_company_id)
        or (coalesce(v_contact_id, '') <> '' and coalesce(v_ref->>'contactId', '') <> '' and v_ref->>'contactId' is distinct from v_contact_id)
      ) then raise exception 'Сделка не относится к выбранной компании или контакту'; end if;
    insert into public.records(entity, id, data) values ('financeRelations', v_relation->>'id', v_relation);
  end loop;
  if p_payload->'event' is not null and jsonb_typeof(p_payload->'event') = 'object' then
    if p_payload->'event'->>'financeId' is distinct from v_finance_id
        or p_payload->'event'->>'businessId' is distinct from v_business_id
        or p_payload->'event'->>'unit' is distinct from v_business_id
        or left(coalesce(p_payload->'event'->>'idempotencyKey', ''), length(v_key) + 1) is distinct from v_key || ':' then
      raise exception 'Связь события не относится к текущему применению правила';
    end if;
    perform public.event_allocate_finance(p_payload->'event', false);
  end if;
  v_application := v_application || jsonb_build_object(
    'financeId', v_finance_id, 'financeFingerprint', md5(v_finance::text),
    'amountMinor', v_amount_minor, 'day', v_today, 'state', 'applied'
  );
  insert into public.records(entity, id, data) values ('bankRuleApplications', v_application->>'id', v_application);
  delete from public.records where entity = 'bankTransactions' and id = v_queue_id;
  return jsonb_build_object('ok', true, 'applied', true, 'item', v_finance, 'application', v_application);
end;
$$;

create or replace function public.correct_bank_rule_transaction(
  p_application_id text, p_patch jsonb, p_idempotency_key text, p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_requested jsonb;
  v_source jsonb;
  v_existing jsonb;
  v_finance jsonb;
  v_before jsonb;
  v_after jsonb;
  v_audit jsonb;
  v_bank_id text;
  v_id text := 'bank-application:' || md5(p_idempotency_key);
begin
  if p_idempotency_key !~ '^[A-Za-z0-9:_-]{8,160}$' or jsonb_typeof(p_patch) <> 'object'
      or exists (select 1 from jsonb_object_keys(p_patch) as keys(key) where key not in ('category', 'method', 'owner', 'comment', 'counterparty')) then
    raise exception 'Некорректное исправление';
  end if;
  if (p_patch ? 'category' and (btrim(coalesce(p_patch->>'category', '')) = '' or length(p_patch->>'category') > 120))
      or (p_patch ? 'method' and coalesce(p_patch->>'method', '') not in ('account', 'card', 'sbp', 'cash', 'other'))
      or (p_patch ? 'owner' and length(coalesce(p_patch->>'owner', '')) > 128)
      or (p_patch ? 'comment' and length(coalesce(p_patch->>'comment', '')) > 300)
      or (p_patch ? 'counterparty' and length(coalesce(p_patch->>'counterparty', '')) > 160) then
    raise exception 'Некорректные значения исправления';
  end if;
  if exists (select 1 from jsonb_each(p_patch) as fields(key, value)
    where jsonb_typeof(value) <> 'string' and not (jsonb_typeof(value) = 'null' and key in ('owner', 'comment', 'counterparty'))) then
    raise exception 'Поля исправления должны быть строками или явным очищением';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bank-app:' || p_idempotency_key, 0));
  select data into v_existing from public.records where entity = 'bankRuleApplications' and data->>'idempotencyKey' = p_idempotency_key;
  if v_existing is not null then
    if v_existing->>'sourceApplicationId' is distinct from p_application_id
        or v_existing->>'patchChecksum' is distinct from md5(p_patch::text) then raise exception 'Ключ повторяемости использован для другого исправления'; end if;
    return jsonb_build_object('ok', true, 'application', v_existing, 'alreadyProcessed', true);
  end if;
  select data into v_requested from public.records where entity = 'bankRuleApplications' and id = p_application_id;
  if v_requested is null or v_requested->>'state' not in ('applied', 'corrected') then raise exception 'Применение правила не найдено'; end if;
  select data->>'bankId' into v_bank_id from public.records where entity = 'finance' and id = v_requested->>'financeId';
  if coalesce(v_bank_id, '') = '' then raise exception 'Финансовая операция не найдена'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_bank_id, 0));
  select data into v_source from public.records where entity = 'bankRuleApplications'
    and data->>'financeId' = v_requested->>'financeId' and data->>'state' in ('applied', 'corrected')
    order by coalesce((data->>'created')::bigint, 0) desc, id desc limit 1;
  select data into v_finance from public.records where entity = 'finance' and id = v_source->>'financeId' for update;
  if md5(v_finance::text) is distinct from v_source->>'financeFingerprint' then raise exception 'Финансовая операция уже изменилась'; end if;
  if coalesce(p_patch->>'owner', '') <> '' and not exists (
    select 1 from public.records where entity = 'businessOwners'
      and data->>'businessId' = v_finance->>'businessId' and data->>'unit' = v_finance->>'businessId'
      and data->>'ownerId' = p_patch->>'owner' and coalesce(data->>'active', 'true') <> 'false'
  ) then raise exception 'Владелец не относится к бизнесу'; end if;
  v_before := jsonb_build_object('category', v_finance->'category', 'method', v_finance->'method', 'owner', v_finance->'owner', 'comment', v_finance->'comment', 'counterparty', v_finance->'counterparty');
  v_finance := v_finance || p_patch || jsonb_build_object('updated', floor(extract(epoch from clock_timestamp()) * 1000));
  v_after := jsonb_build_object('category', v_finance->'category', 'method', v_finance->'method', 'owner', v_finance->'owner', 'comment', v_finance->'comment', 'counterparty', v_finance->'counterparty');
  perform set_config('app.bank_rules_rpc', 'correct', true);
  update public.records set data = v_finance where entity = 'finance' and id = v_source->>'financeId';
  v_audit := jsonb_build_object(
    'id', v_id, 'idempotencyKey', p_idempotency_key, 'decision', 'correct', 'state', 'corrected',
    'sourceApplicationId', p_application_id, 'patchChecksum', md5(p_patch::text),
    'financeId', v_source->>'financeId', 'supersedes', v_source->>'id',
    'before', v_before, 'after', v_after, 'actor', p_actor,
    'operationDate', v_finance->>'date', 'businessId', v_finance->>'businessId',
    'category', v_finance->>'category', 'method', v_finance->>'method',
    'auditRef', 'audit-' || right(md5(v_id), 8), 'canReverse', coalesce((v_source->>'canReverse')::boolean, true),
    'financeFingerprint', md5(v_finance::text), 'created', floor(extract(epoch from clock_timestamp()) * 1000)
  );
  insert into public.records(entity, id, data) values ('bankRuleApplications', v_id, v_audit);
  return jsonb_build_object('ok', true, 'item', v_finance, 'application', v_audit);
end;
$$;

create or replace function public.reverse_bank_rule_transaction(
  p_application_id text, p_idempotency_key text, p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_requested jsonb;
  v_source jsonb;
  v_existing jsonb;
  v_finance jsonb;
  v_queue jsonb;
  v_audit jsonb;
  v_bank_id text;
  v_id text := 'bank-application:' || md5(p_idempotency_key);
begin
  if p_idempotency_key !~ '^[A-Za-z0-9:_-]{8,160}$' then raise exception 'Некорректный ключ повторяемости'; end if;
  perform pg_advisory_xact_lock(hashtextextended('bank-app:' || p_idempotency_key, 0));
  select data into v_existing from public.records where entity = 'bankRuleApplications' and data->>'idempotencyKey' = p_idempotency_key;
  if v_existing is not null then
    if v_existing->>'sourceApplicationId' is distinct from p_application_id then raise exception 'Ключ повторяемости использован для другой отмены'; end if;
    return jsonb_build_object('ok', true, 'application', v_existing, 'alreadyProcessed', true);
  end if;
  select data into v_requested from public.records where entity = 'bankRuleApplications' and id = p_application_id;
  if v_requested is null or v_requested->>'state' not in ('applied', 'corrected') then raise exception 'Применение правила не найдено'; end if;
  select data->>'bankId' into v_bank_id from public.records where entity = 'finance' and id = v_requested->>'financeId';
  if coalesce(v_bank_id, '') = '' then raise exception 'Финансовая операция не найдена'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_bank_id, 0));
  select data into v_source from public.records where entity = 'bankRuleApplications'
    and data->>'financeId' = v_requested->>'financeId' and data->>'state' in ('applied', 'corrected')
    order by coalesce((data->>'created')::bigint, 0) desc, id desc limit 1;
  if coalesce((v_source->>'canReverse')::boolean, true) = false or coalesce(v_source->>'operation', '') = 'legacy_backfill' then
    raise exception 'Историческую банковскую операцию можно исправить, но нельзя вернуть в очередь';
  end if;
  select data into v_finance from public.records where entity = 'finance' and id = v_source->>'financeId' for update;
  if v_finance is null or md5(v_finance::text) is distinct from v_source->>'financeFingerprint' then raise exception 'Финансовая операция уже изменилась'; end if;
  if exists (select 1 from public.records where entity = 'financeRelations' and data->>'financeId' = v_source->>'financeId')
      or exists (select 1 from public.records where entity = 'eventFinanceAllocations' and data->>'financeId' = v_source->>'financeId')
      or exists (select 1 from public.records where entity = 'stockMovements' and data->>'financeId' = v_source->>'financeId') then
    raise exception 'У финансовой операции есть неизменяемые связи';
  end if;
  if exists (select 1 from public.records where entity = 'bankTransactions' and data->>'bankId' = v_bank_id) then
    raise exception 'Операция уже находится в очереди';
  end if;
  v_queue := jsonb_build_object(
    'id', v_finance->>'bankQueueId', 'bankId', v_bank_id, 'date', v_finance->>'date',
    'type', v_finance->>'type', 'amount', v_finance->'amount',
    'method', coalesce(v_finance->'bankOriginal'->>'method', v_finance->>'method'),
    'source', 'bank', 'counterparty', coalesce(v_finance->'bankOriginal'->>'counterparty', ''),
    'comment', coalesce(v_finance->'bankOriginal'->>'comment', ''),
    'bankSignals', coalesce(v_finance->'bankSignals', '{}'::jsonb),
    'bankSignalFingerprint', v_finance->>'bankSignalFingerprint',
    'bankRuleState', 'pending', 'created', coalesce(v_finance->'created', to_jsonb(floor(extract(epoch from clock_timestamp()) * 1000))),
    'updated', floor(extract(epoch from clock_timestamp()) * 1000)
  );
  perform set_config('app.bank_rules_rpc', 'reverse', true);
  delete from public.records where entity = 'finance' and id = v_source->>'financeId';
  insert into public.records(entity, id, data) values ('bankTransactions', v_queue->>'id', v_queue);
  v_audit := jsonb_build_object(
    'id', v_id, 'idempotencyKey', p_idempotency_key, 'decision', 'reverse', 'state', 'reversed',
    'sourceApplicationId', p_application_id,
    'supersedes', v_source->>'id', 'actor', p_actor,
    'created', floor(extract(epoch from clock_timestamp()) * 1000)
  );
  insert into public.records(entity, id, data) values ('bankRuleApplications', v_id, v_audit);
  return jsonb_build_object('ok', true, 'application', v_audit);
end;
$$;

create or replace function public.bank_rule_restore_graph(p_graph jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entity text;
  v_item jsonb;
  v_existing jsonb;
  v_existing_entity text;
  v_finance jsonb;
  v_target jsonb;
  v_relation_entity text;
  v_amount_minor bigint;
  v_count integer := 0;
begin
  if jsonb_typeof(p_graph) <> 'object' then raise exception 'Некорректная резервная копия правил'; end if;
  perform pg_advisory_xact_lock(hashtext('bank_rule_restore_graph'));
  perform set_config('app.bank_rules_rpc', 'restore', true);
  if jsonb_typeof(coalesce(p_graph->'bankFinance', '[]'::jsonb)) <> 'array' then
    raise exception 'Некорректный раздел банковских финансов';
  end if;
  for v_item in select value from jsonb_array_elements(coalesce(p_graph->'bankFinance', '[]'::jsonb)) loop
    if coalesce(v_item->>'id', '') = '' or coalesce(v_item->>'bankId', '') = ''
        or v_item->>'source' is distinct from 'bank'
        or coalesce(v_item->>'businessId', '') = '' or v_item->>'unit' is distinct from v_item->>'businessId'
        or v_item->>'type' not in ('income', 'expense')
        or coalesce((v_item->>'amount')::numeric, 0) <= 0 then
      raise exception 'Некорректная банковская финансовая операция';
    end if;
    if coalesce(v_item->'bankSignals', '{}'::jsonb) <> '{}'::jsonb then
      begin
        v_amount_minor := (v_item->'bankSignals'->>'amountMinor')::bigint;
      exception when others then
        raise exception 'bankSignals финансовой операции не согласован';
      end;
      if v_amount_minor <= 0 or v_amount_minor is distinct from round((v_item->>'amount')::numeric * 100)::bigint
          or v_item->'bankSignals'->>'direction' is distinct from v_item->>'type' then
        raise exception 'bankSignals финансовой операции не согласован';
      end if;
    end if;
    if not exists (select 1 from public.records where entity = 'businesses' and id = v_item->>'businessId') then
      raise exception 'Бизнес банковской финансовой операции не найден';
    end if;
    if coalesce(v_item->>'owner', '') <> '' and not exists (
      select 1 from public.records where entity = 'businessOwners'
      and data->>'businessId' = v_item->>'businessId' and data->>'unit' = v_item->>'businessId'
      and data->>'ownerId' = v_item->>'owner' and coalesce(data->>'active', 'true') <> 'false'
    ) then raise exception 'Владелец банковской операции не относится к бизнесу'; end if;
    perform pg_advisory_xact_lock(hashtextextended(v_item->>'bankId', 0));
    select entity, data into v_existing_entity, v_existing from public.records
    where (entity = 'finance' and (id = v_item->>'id' or data->>'bankId' = v_item->>'bankId'))
       or (entity = 'bankTransactions' and data->>'bankId' = v_item->>'bankId')
    order by entity, id limit 1 for update;
    if v_existing is not null then
      if v_existing_entity <> 'finance' or v_existing is distinct from v_item then
        raise exception 'Резервная банковская финансовая операция конфликтует с существующей записью';
      end if;
    else
      insert into public.records(entity, id, data) values ('finance', v_item->>'id', v_item);
    end if;
    v_count := v_count + 1;
  end loop;
  foreach v_entity in array array['bankRules', 'bankRuleVersions', 'bankRuleSettingVersions', 'bankRuleApplications', 'bankRuleRuns', 'bankRuleSettings', 'financeRelations'] loop
    if jsonb_typeof(coalesce(p_graph->v_entity, '[]'::jsonb)) <> 'array' then raise exception 'Некорректный раздел правил'; end if;
    for v_item in select value from jsonb_array_elements(coalesce(p_graph->v_entity, '[]'::jsonb)) loop
      if coalesce(v_item->>'id', '') = '' then raise exception 'У записи правил нет id'; end if;
      if v_entity = 'financeRelations' then
        if v_item->>'businessId' is distinct from v_item->>'unit' then raise exception 'Область финансовой связи не совпадает'; end if;
        -- Всегда берём блокировку банковской операции раньше строки finance.
        -- Иначе восстановление связи могло войти в дедлок с безопасной отменой
        -- (она использует порядок bankId -> finance).
        select data into v_finance from public.records where entity = 'finance' and id = v_item->>'financeId';
        if coalesce(v_finance->>'bankId', '') <> '' then
          perform pg_advisory_xact_lock(hashtextextended(v_finance->>'bankId', 0));
        end if;
        select data into v_finance from public.records where entity = 'finance' and id = v_item->>'financeId' for update;
        v_relation_entity := case v_item->>'relationType'
          when 'player' then 'players' when 'company' then 'companies' when 'contact' then 'contacts' when 'deal' then 'deals' else '' end;
        if v_relation_entity = '' then raise exception 'Неизвестный тип финансовой связи'; end if;
        select data into v_target from public.records where entity = v_relation_entity and id = v_item->>'relationId';
        if v_finance is null or v_target is null
            or v_finance->>'businessId' is distinct from v_item->>'businessId'
            or v_finance->>'unit' is distinct from v_item->>'businessId'
            or v_target->>'businessId' is distinct from v_item->>'businessId'
            or v_target->>'unit' is distinct from v_item->>'businessId' then
          raise exception 'Резервная финансовая связь не относится к бизнесу';
        end if;
      end if;
      select data into v_existing from public.records where entity = v_entity and id = v_item->>'id';
      if v_entity = 'bankRuleSettings' then
        if v_item->>'id' <> 'bank-rule-settings' or coalesce((v_item->>'settingsVersion')::integer, 0) < 1
            or jsonb_typeof(v_item->'allowedDirections') <> 'array' or jsonb_typeof(v_item->'maxAmountMinor') <> 'object' then
          raise exception 'Некорректные настройки правил в резервной копии';
        end if;
        select data into v_target from public.records where entity = 'bankRuleSettingVersions'
          and (data->>'settingsVersion')::integer = (v_item->>'settingsVersion')::integer;
        if v_target is null or jsonb_build_object(
            'autoEnabled', v_target->'autoEnabled', 'allowedDirections', v_target->'allowedDirections',
            'maxAmountMinor', v_target->'maxAmountMinor', 'maxTransactionsPerRun', v_target->'maxTransactionsPerRun',
            'maxTransactionsPerDay', v_target->'maxTransactionsPerDay', 'maxTotalAmountMinorPerDay', v_target->'maxTotalAmountMinorPerDay'
          ) is distinct from jsonb_build_object(
            'autoEnabled', v_item->'autoEnabled', 'allowedDirections', v_item->'allowedDirections',
            'maxAmountMinor', v_item->'maxAmountMinor', 'maxTransactionsPerRun', v_item->'maxTransactionsPerRun',
            'maxTransactionsPerDay', v_item->'maxTransactionsPerDay', 'maxTotalAmountMinorPerDay', v_item->'maxTotalAmountMinorPerDay'
          ) then raise exception 'Текущие настройки не подтверждены неизменяемой версией'; end if;
        if v_existing is not null and not (
            coalesce((v_existing->>'settingsVersion')::integer, 0) = 1
            and coalesce((v_existing->>'autoEnabled')::boolean, false) = false
            and v_existing->'allowedDirections' = jsonb_build_array('income', 'expense')
            and v_existing->'maxAmountMinor' = jsonb_build_object('income', 1000000, 'expense', 1000000)
            and coalesce((v_existing->>'maxTransactionsPerRun')::integer, 0) = 10
            and coalesce((v_existing->>'maxTransactionsPerDay')::integer, 0) = 20
            and coalesce((v_existing->>'maxTotalAmountMinorPerDay')::bigint, 0) = 5000000
          ) and v_existing is distinct from v_item then
          raise exception 'Резервная копия не может откатить действующие настройки';
        end if;
        insert into public.records(entity, id, data) values (v_entity, v_item->>'id', v_item)
          on conflict (entity, id) do update set data = excluded.data;
      elsif v_entity = 'bankRuleSettingVersions' and v_item->>'id' = 'bank-rule-settings:v1' and v_existing is not null then
        if jsonb_build_object(
            'autoEnabled', v_existing->'autoEnabled', 'allowedDirections', v_existing->'allowedDirections',
            'maxAmountMinor', v_existing->'maxAmountMinor', 'maxTransactionsPerRun', v_existing->'maxTransactionsPerRun',
            'maxTransactionsPerDay', v_existing->'maxTransactionsPerDay', 'maxTotalAmountMinorPerDay', v_existing->'maxTotalAmountMinorPerDay'
          ) is distinct from jsonb_build_object(
            'autoEnabled', v_item->'autoEnabled', 'allowedDirections', v_item->'allowedDirections',
            'maxAmountMinor', v_item->'maxAmountMinor', 'maxTransactionsPerRun', v_item->'maxTransactionsPerRun',
            'maxTransactionsPerDay', v_item->'maxTransactionsPerDay', 'maxTotalAmountMinorPerDay', v_item->'maxTotalAmountMinorPerDay'
          ) then raise exception 'Резервная копия конфликтует с начальной версией настроек'; end if;
      elsif v_existing is not null and v_existing is distinct from v_item then
        raise exception 'Резервная копия конфликтует с историей правил';
      elsif v_existing is null then
        insert into public.records(entity, id, data) values (v_entity, v_item->>'id', v_item);
      end if;
      v_count := v_count + 1;
    end loop;
  end loop;
  for v_item in select value from jsonb_array_elements(coalesce(p_graph->'bankFinance', '[]'::jsonb)) loop
    if coalesce(v_item->>'applicationId', '') <> '' and not exists (
      select 1 from public.records where entity = 'bankRuleApplications'
      and id = v_item->>'applicationId' and data->>'financeId' = v_item->>'id'
    ) then raise exception 'Применение правила банковской операции не найдено'; end if;
    if coalesce(v_item->>'applicationId', '') = '' and not exists (
      select 1 from public.records where entity = 'bankRuleApplications' and data->>'financeId' = v_item->>'id'
    ) then
      v_target := jsonb_build_object(
        'id', 'bank-application:legacy:' || md5(v_item->>'id'),
        'idempotencyKey', 'legacy:' || md5(v_item->>'id'),
        'operation', 'legacy_backfill', 'decision', 'legacy', 'state', 'applied',
        'financeId', v_item->>'id', 'financeFingerprint', md5(v_item::text),
        'operationDate', v_item->>'date', 'businessId', v_item->>'businessId',
        'category', v_item->>'category', 'method', v_item->>'method',
        'auditRef', 'legacy-' || left(md5(v_item->>'id'), 8), 'canReverse', false,
        'actor', 'restore', 'created', case
          when coalesce(v_item->>'updated', '') ~ '^[0-9]+$' then (v_item->>'updated')::bigint
          when coalesce(v_item->>'created', '') ~ '^[0-9]+$' then (v_item->>'created')::bigint
          else 0 end
      );
      insert into public.records(entity, id, data) values ('bankRuleApplications', v_target->>'id', v_target);
      v_count := v_count + 1;
    end if;
  end loop;
  if jsonb_typeof(coalesce(p_graph->'bankTransactions', '[]'::jsonb)) <> 'array' then
    raise exception 'Некорректный раздел банковской очереди';
  end if;
  for v_item in select value from jsonb_array_elements(coalesce(p_graph->'bankTransactions', '[]'::jsonb)) loop
    if coalesce(v_item->>'id', '') = '' or coalesce(v_item->>'bankId', '') = '' then
      raise exception 'У банковской операции нет id или bankId';
    end if;
    select data into v_existing from public.records
    where (entity = 'bankTransactions' and (id = v_item->>'id' or data->>'bankId' = v_item->>'bankId'))
       or (entity = 'finance' and data->>'bankId' = v_item->>'bankId')
    order by entity, id limit 1 for update;
    if v_existing is not null then
      if v_existing is distinct from v_item then
        raise exception 'Резервная банковская очередь конфликтует с существующей операцией';
      end if;
    else
      perform public.bank_enqueue_transaction(v_item);
    end if;
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('ok', true, 'restored', v_count);
end;
$$;

create or replace function public.restore_monetki_backup(p_graph jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entity text;
  v_item jsonb;
  v_bank_result jsonb;
  v_event_result jsonb;
  v_count integer := 0;
begin
  if jsonb_typeof(p_graph) <> 'object'
      or jsonb_typeof(coalesce(p_graph->'ordinary', '{}'::jsonb)) <> 'object'
      or jsonb_typeof(coalesce(p_graph->'bank', '{}'::jsonb)) <> 'object'
      or jsonb_typeof(coalesce(p_graph->'events', '{}'::jsonb)) <> 'object' then
    raise exception 'Некорректная резервная копия';
  end if;
  perform pg_advisory_xact_lock(hashtext('restore_monetki_backup'));
  foreach v_entity in array array[
    'businesses', 'memberships', 'businessOwners', 'employees', 'clients', 'companies', 'contacts', 'leads', 'deals',
    'pipelines', 'stages', 'dealItems', 'venues', 'players', 'tasks', 'finance', 'staffExpenses', 'cash', 'notifications',
    'warehouses', 'stockItems', 'stockMovements', 'stockBalances', 'reservations', 'inventories', 'files'
  ] loop
    if jsonb_typeof(coalesce(p_graph->'ordinary'->v_entity, '[]'::jsonb)) <> 'array' then
      raise exception 'Некорректный раздел резервной копии';
    end if;
    for v_item in select value from jsonb_array_elements(coalesce(p_graph->'ordinary'->v_entity, '[]'::jsonb)) loop
      if coalesce(v_item->>'id', '') = '' then raise exception 'У записи резервной копии нет id'; end if;
      if v_entity = 'finance' and (
          coalesce(v_item->>'source', '') = 'bank' or coalesce(v_item->>'bankId', '') <> ''
          or v_item ?| array['bankQueueId', 'bankSignals', 'bankSignalFingerprint', 'bankOriginal', 'appliedRuleId', 'appliedRuleVersion', 'applicationId']
        ) then raise exception 'Банковская finance должна восстанавливаться банковским графом'; end if;
      insert into public.records(entity, id, data) values (v_entity, v_item->>'id', v_item)
      on conflict (entity, id) do update set data = excluded.data;
      v_count := v_count + 1;
    end loop;
  end loop;
  v_bank_result := public.bank_rule_restore_graph(p_graph->'bank');
  if coalesce((v_bank_result->>'ok')::boolean, false) = false then raise exception 'Не удалось восстановить банковский граф'; end if;
  v_event_result := public.event_restore_graph(p_graph->'events');
  if coalesce((v_event_result->>'ok')::boolean, false) = false then raise exception 'Не удалось восстановить граф событий'; end if;
  return jsonb_build_object(
    'ok', true,
    'restored', v_count + coalesce((v_bank_result->>'restored')::integer, 0) + coalesce((v_event_result->>'restored')::integer, 0)
  );
end;
$$;

revoke all on function public.bank_enqueue_transaction(jsonb) from public, anon, authenticated;
revoke all on function public.bank_rule_save(jsonb, integer, text) from public, anon, authenticated;
revoke all on function public.bank_rule_settings_save(jsonb, integer, text) from public, anon, authenticated;
revoke all on function public.bank_rule_append_run(jsonb) from public, anon, authenticated;
revoke all on function public.apply_bank_rule_transaction(jsonb) from public, anon, authenticated;
revoke all on function public.correct_bank_rule_transaction(text, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.reverse_bank_rule_transaction(text, text, text) from public, anon, authenticated;
revoke all on function public.bank_rule_restore_graph(jsonb) from public, anon, authenticated;
revoke all on function public.restore_monetki_backup(jsonb) from public, anon, authenticated;
grant execute on function public.bank_enqueue_transaction(jsonb) to service_role;
grant execute on function public.bank_rule_save(jsonb, integer, text) to service_role;
grant execute on function public.bank_rule_settings_save(jsonb, integer, text) to service_role;
grant execute on function public.bank_rule_append_run(jsonb) to service_role;
grant execute on function public.apply_bank_rule_transaction(jsonb) to service_role;
grant execute on function public.correct_bank_rule_transaction(text, jsonb, text, text) to service_role;
grant execute on function public.reverse_bank_rule_transaction(text, text, text) to service_role;
grant execute on function public.bank_rule_restore_graph(jsonb) to service_role;
grant execute on function public.restore_monetki_backup(jsonb) to service_role;

notify pgrst, 'reload schema';
