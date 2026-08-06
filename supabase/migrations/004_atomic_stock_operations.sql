-- Атомарные складские операции. RPC доступны только Edge Function (service_role).

create or replace function stock_apply_movement(p_item jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_business text := coalesce(p_item->>'businessId', p_item->>'unit', '');
  v_type text := coalesce(p_item->>'type', '');
  v_item text := coalesce(p_item->>'stockItemId', '');
  v_id text := coalesce(p_item->>'id', '');
  v_qty numeric;
  v_now bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_warehouses text[];
  v_balance_ids text[];
  v_warehouse text;
  v_balance_id text;
  v_balance jsonb;
  v_delta numeric;
  v_next numeric;
  v_reserved numeric;
  v_inserted integer;
  v_finance jsonb;
begin
  if v_business = '' or p_item->>'businessId' is distinct from v_business
      or p_item->>'unit' is distinct from v_business then
    raise exception using errcode = 'P0001', message = 'businessId и unit должны совпадать';
  end if;
  if v_id = '' then
    raise exception using errcode = 'P0001', message = 'Не указан ID движения';
  end if;
  if v_type not in ('receipt', 'expense', 'transfer') then
    raise exception using errcode = 'P0001', message = 'Неизвестный тип движения';
  end if;
  begin v_qty := (p_item->>'quantity')::numeric;
  exception when others then
    raise exception using errcode = 'P0001', message = 'Количество должно быть больше нуля';
  end;
  if v_qty is null or v_qty <= 0 then
    raise exception using errcode = 'P0001', message = 'Количество должно быть больше нуля';
  end if;
  if coalesce(p_item->>'financeId', '') <> '' then
    select data into v_finance from records
    where entity = 'finance' and id = p_item->>'financeId' for update;
    if v_finance is null
        or coalesce(v_finance->>'businessId', v_finance->>'unit') is distinct from v_business
        or v_finance->>'businessId' is distinct from v_business
        or v_finance->>'unit' is distinct from v_business
        or v_finance->>'type' is distinct from 'expense' then
      raise exception using errcode = 'P0001', message = 'Связанный расход не найден в этом бизнесе';
    end if;
  end if;
  if v_type = 'transfer' then
    if coalesce(p_item->>'fromWarehouseId', '') = ''
        or coalesce(p_item->>'toWarehouseId', '') = ''
        or p_item->>'fromWarehouseId' = p_item->>'toWarehouseId' then
      raise exception using errcode = 'P0001', message = 'Для перемещения нужны два разных склада';
    end if;
    v_warehouses := array[p_item->>'fromWarehouseId', p_item->>'toWarehouseId'];
  else
    if coalesce(p_item->>'warehouseId', '') = '' then
      raise exception using errcode = 'P0001', message = 'Не указан склад';
    end if;
    v_warehouses := array[p_item->>'warehouseId'];
  end if;
  select array_agg(warehouse_id order by warehouse_id)
  into v_warehouses from unnest(v_warehouses) warehouse_id;
  -- Каталог всегда блокируется до остатков. Удаление использует тот же порядок.
  perform 1 from records
  where (entity = 'stockItems' and id = v_item)
     or (entity = 'warehouses' and id = any(v_warehouses))
  order by entity, id for update;
  if not exists (
    select 1 from records where entity = 'stockItems' and id = v_item
      and coalesce(data->>'businessId', data->>'unit') = v_business
      and data->>'active' is distinct from 'false'
  ) then
    raise exception using errcode = 'P0001', message = 'Позиция склада не найдена в этом бизнесе';
  end if;
  if exists (
    select 1 from unnest(v_warehouses) warehouse_id
    where not exists (
      select 1 from records where entity = 'warehouses' and id = warehouse_id
        and coalesce(data->>'businessId', data->>'unit') = v_business
        and data->>'active' is distinct from 'false'
    )
  ) then
    raise exception using errcode = 'P0001', message = 'Склад не найден в этом бизнесе';
  end if;

  -- Уникальный ID захватывается до изменения остатков. Ошибка откатывает всё.
  insert into records(entity, id, data) values ('stockMovements', v_id, p_item)
  on conflict (entity, id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    raise exception using errcode = 'P0001', message = 'Движение с таким ID уже существует';
  end if;

  select array_agg('stock-balance-' || warehouse_id || '::' || v_item order by warehouse_id)
  into v_balance_ids from unnest(v_warehouses) warehouse_id;
  foreach v_warehouse in array v_warehouses loop
    v_balance_id := 'stock-balance-' || v_warehouse || '::' || v_item;
    insert into records(entity, id, data) values (
      'stockBalances', v_balance_id, jsonb_build_object(
        'id', v_balance_id, 'businessId', v_business, 'unit', v_business,
        'warehouseId', v_warehouse, 'stockItemId', v_item,
        'quantity', 0, 'reserved', 0, 'created', v_now
      )
    ) on conflict (entity, id) do nothing;
  end loop;
  perform 1 from records
  where entity = 'stockBalances' and id = any(v_balance_ids)
  order by id for update;

  foreach v_warehouse in array v_warehouses loop
    v_balance_id := 'stock-balance-' || v_warehouse || '::' || v_item;
    select data into strict v_balance from records
    where entity = 'stockBalances' and id = v_balance_id;
    if coalesce(v_balance->>'businessId', v_balance->>'unit') <> v_business
        or v_balance->>'warehouseId' is distinct from v_warehouse
        or v_balance->>'stockItemId' is distinct from v_item then
      raise exception using errcode = 'P0001', message = 'Нарушена изоляция складского остатка';
    end if;
    v_delta := case
      when v_type = 'receipt' then v_qty
      when v_type = 'expense' then -v_qty
      when v_warehouse = p_item->>'fromWarehouseId' then -v_qty
      else v_qty end;
    v_next := coalesce((v_balance->>'quantity')::numeric, 0) + v_delta;
    v_reserved := coalesce((v_balance->>'reserved')::numeric, 0);
    if v_next < v_reserved then
      if v_reserved > 0 then
        raise exception using errcode = 'P0001', message = 'Недостаточно свободного остатка: часть товара зарезервирована';
      end if;
      raise exception using errcode = 'P0001', message = 'Недостаточно товара на складе';
    end if;
    update records set data = jsonb_set(
      jsonb_set(data, '{quantity}', to_jsonb(v_next), true),
      '{updated}', to_jsonb(v_now), true
    ) where entity = 'stockBalances' and id = v_balance_id;
  end loop;
  return jsonb_build_object('ok', true, 'item', p_item);
end $$;

drop function if exists stock_complete_inventory(jsonb, boolean);

create or replace function stock_complete_inventory(
  p_inventory jsonb,
  p_allow_create boolean default false,
  p_expected jsonb default null
)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_id text := coalesce(p_inventory->>'id', '');
  v_existing jsonb;
  v_completed jsonb;
  v_business text;
  v_warehouse text;
  v_line jsonb;
  v_item text;
  v_balance_id text;
  v_balance jsonb;
  v_actual numeric;
  v_previous numeric;
  v_reserved numeric;
  v_delta numeric;
  v_now bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_movement_id text;
begin
  if v_id = '' then raise exception using errcode = 'P0001', message = 'Не указан ID инвентаризации'; end if;
  select data into v_existing from records
  where entity = 'inventories' and id = v_id for update;
  if not found then
    if not p_allow_create then
      raise exception using errcode = 'P0001', message = 'Инвентаризация не найдена';
    end if;
    insert into records(entity, id, data)
    values ('inventories', v_id, p_inventory || jsonb_build_object('status', 'draft'))
    on conflict (entity, id) do nothing;
    select data into strict v_existing from records
    where entity = 'inventories' and id = v_id for update;
  end if;
  v_business := coalesce(v_existing->>'businessId', v_existing->>'unit', '');
  v_warehouse := coalesce(v_existing->>'warehouseId', '');
  if v_business = '' or p_inventory->>'businessId' is distinct from v_business
      or p_inventory->>'unit' is distinct from v_business
      or p_inventory->>'warehouseId' is distinct from v_warehouse then
    raise exception using errcode = 'P0001', message = 'Нельзя перенести инвентаризацию в другой бизнес или склад';
  end if;
  if v_existing->>'status' = 'completed' then
    return jsonb_build_object('ok', true, 'item', v_existing, 'alreadyCompleted', true);
  end if;
  if p_expected is not null and v_existing is distinct from p_expected then
    raise exception using errcode = 'P0001', message = 'Инвентаризация уже изменена другим запросом';
  end if;
  if v_existing->>'status' <> 'draft' or p_inventory->>'status' <> 'completed' then
    raise exception using errcode = 'P0001', message = 'Завершить можно только черновик инвентаризации';
  end if;
  if not exists (
    select 1 from records where entity = 'warehouses' and id = v_warehouse
      and coalesce(data->>'businessId', data->>'unit') = v_business
      and data->>'active' is distinct from 'false'
  ) then
    raise exception using errcode = 'P0001', message = 'Склад не найден в этом бизнесе';
  end if;
  if jsonb_typeof(p_inventory->'items') <> 'array' or jsonb_array_length(p_inventory->'items') = 0 then
    raise exception using errcode = 'P0001', message = 'Добавьте позиции инвентаризации';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_inventory->'items') line
    group by line->>'stockItemId'
    having coalesce(line->>'stockItemId', '') = '' or count(*) > 1
  ) then
    raise exception using errcode = 'P0001', message = 'Позиции инвентаризации не должны повторяться';
  end if;

  perform 1 from records
  where (entity = 'warehouses' and id = v_warehouse)
     or (entity = 'stockItems' and id in (
       select line->>'stockItemId' from jsonb_array_elements(p_inventory->'items') line
     ))
  order by entity, id for update;
  if not exists (
    select 1 from records where entity = 'warehouses' and id = v_warehouse
      and coalesce(data->>'businessId', data->>'unit') = v_business
      and data->>'active' is distinct from 'false'
  ) then
    raise exception using errcode = 'P0001', message = 'Склад не найден в этом бизнесе';
  end if;

  for v_line in
    select value from jsonb_array_elements(p_inventory->'items')
    order by value->>'stockItemId'
  loop
    v_item := v_line->>'stockItemId';
    if not exists (
      select 1 from records where entity = 'stockItems' and id = v_item
        and coalesce(data->>'businessId', data->>'unit') = v_business
        and data->>'active' is distinct from 'false'
    ) then
      raise exception using errcode = 'P0001', message = 'Позиция склада не найдена в этом бизнесе';
    end if;
    begin v_actual := (v_line->>'actualQuantity')::numeric;
    exception when others then
      raise exception using errcode = 'P0001', message = 'Фактический остаток должен быть неотрицательным числом';
    end;
    if v_actual is null or v_actual < 0 then
      raise exception using errcode = 'P0001', message = 'Фактический остаток должен быть неотрицательным числом';
    end if;
    v_balance_id := 'stock-balance-' || v_warehouse || '::' || v_item;
    insert into records(entity, id, data) values (
      'stockBalances', v_balance_id, jsonb_build_object(
        'id', v_balance_id, 'businessId', v_business, 'unit', v_business,
        'warehouseId', v_warehouse, 'stockItemId', v_item,
        'quantity', 0, 'reserved', 0, 'created', v_now
      )
    ) on conflict (entity, id) do nothing;
  end loop;

  perform 1 from records
  where entity = 'stockBalances' and id in (
    select 'stock-balance-' || v_warehouse || '::' || (line->>'stockItemId')
    from jsonb_array_elements(p_inventory->'items') line
  ) order by id for update;

  for v_line in select value from jsonb_array_elements(p_inventory->'items') loop
    v_item := v_line->>'stockItemId';
    v_actual := (v_line->>'actualQuantity')::numeric;
    v_balance_id := 'stock-balance-' || v_warehouse || '::' || v_item;
    select data into strict v_balance from records
    where entity = 'stockBalances' and id = v_balance_id;
    if coalesce(v_balance->>'businessId', v_balance->>'unit') <> v_business
        or v_balance->>'warehouseId' is distinct from v_warehouse
        or v_balance->>'stockItemId' is distinct from v_item then
      raise exception using errcode = 'P0001', message = 'Нарушена изоляция складского остатка';
    end if;
    v_previous := coalesce((v_balance->>'quantity')::numeric, 0);
    v_reserved := coalesce((v_balance->>'reserved')::numeric, 0);
    if v_actual < v_reserved then
      raise exception using errcode = 'P0001', message = 'Фактический остаток не может быть меньше резерва';
    end if;
    v_delta := v_actual - v_previous;
    update records set data = jsonb_set(
      jsonb_set(data, '{quantity}', to_jsonb(v_actual), true),
      '{updated}', to_jsonb(v_now), true
    ) where entity = 'stockBalances' and id = v_balance_id;
    if v_delta <> 0 then
      v_movement_id := 'stock-inventory-' || v_id || '-' || v_item;
      insert into records(entity, id, data) values (
        'stockMovements', v_movement_id, jsonb_build_object(
          'id', v_movement_id, 'businessId', v_business, 'unit', v_business,
          'type', 'inventory', 'inventoryId', v_id, 'warehouseId', v_warehouse,
          'stockItemId', v_item, 'quantity', abs(v_delta),
          'direction', case when v_delta > 0 then 'increase' else 'decrease' end,
          'previousQuantity', v_previous, 'actualQuantity', v_actual,
          'date', coalesce(p_inventory->>'date', to_char(current_date, 'YYYY-MM-DD')),
          'note', coalesce(p_inventory->>'note', ''), 'created', v_now, 'updated', v_now
        )
      ) on conflict (entity, id) do nothing;
    end if;
  end loop;

  v_completed := p_inventory || jsonb_build_object('status', 'completed', 'completedAt', v_now, 'updated', v_now);
  update records set data = v_completed where entity = 'inventories' and id = v_id;
  return jsonb_build_object('ok', true, 'item', v_completed);
end $$;

create or replace function stock_save_inventory(p_before jsonb, p_after jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_id text := coalesce(p_before->>'id', '');
  v_existing jsonb;
  v_business text;
  v_warehouse text;
begin
  if v_id = '' then
    raise exception using errcode = 'P0001', message = 'Не указан ID инвентаризации';
  end if;
  select data into v_existing from records
  where entity = 'inventories' and id = v_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'Инвентаризация не найдена';
  end if;
  if v_existing is distinct from p_before then
    raise exception using errcode = 'P0001', message = 'Инвентаризация уже изменена другим запросом';
  end if;
  if v_existing->>'status' <> 'draft' then
    raise exception using errcode = 'P0001', message = 'Завершённую инвентаризацию нельзя изменять или удалять';
  end if;
  if p_after is null then
    delete from records where entity = 'inventories' and id = v_id;
    return jsonb_build_object('ok', true);
  end if;

  v_business := coalesce(v_existing->>'businessId', v_existing->>'unit', '');
  v_warehouse := coalesce(p_after->>'warehouseId', '');
  if p_after->>'id' is distinct from v_id
      or p_after->>'businessId' is distinct from v_business
      or p_after->>'unit' is distinct from v_business
      or p_after->>'status' <> 'draft' then
    raise exception using errcode = 'P0001', message = 'Нельзя перенести или завершить инвентаризацию этим действием';
  end if;
  perform 1 from records
  where (entity = 'warehouses' and id = v_warehouse)
     or (entity = 'stockItems' and id in (
       select line->>'stockItemId' from jsonb_array_elements(coalesce(p_after->'items', '[]'::jsonb)) line
     ))
  order by entity, id for share;
  if not exists (
    select 1 from records where entity = 'warehouses' and id = v_warehouse
      and coalesce(data->>'businessId', data->>'unit') = v_business
      and data->>'active' is distinct from 'false'
  ) or exists (
    select 1 from jsonb_array_elements(coalesce(p_after->'items', '[]'::jsonb)) line
    where not exists (
      select 1 from records where entity = 'stockItems' and id = line->>'stockItemId'
        and coalesce(data->>'businessId', data->>'unit') = v_business
        and data->>'active' is distinct from 'false'
    )
  ) then
    raise exception using errcode = 'P0001', message = 'Склад или позиция не найдены в этом бизнесе';
  end if;
  update records set data = p_after where entity = 'inventories' and id = v_id;
  return jsonb_build_object('ok', true, 'item', p_after);
end $$;

create or replace function stock_delete_catalog(p_entity text, p_item jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_id text := coalesce(p_item->>'id', '');
  v_business text := coalesce(p_item->>'businessId', p_item->>'unit', '');
  v_existing jsonb;
  v_has_reference boolean;
begin
  if p_entity not in ('warehouses', 'stockItems') or v_id = '' or v_business = '' then
    raise exception using errcode = 'P0001', message = 'Некорректная запись складского каталога';
  end if;
  select data into v_existing from records
  where entity = p_entity and id = v_id for update;
  if not found then
    return jsonb_build_object('ok', true);
  end if;
  if coalesce(v_existing->>'businessId', v_existing->>'unit') <> v_business
      or p_item->>'businessId' is distinct from v_business
      or p_item->>'unit' is distinct from v_business then
    raise exception using errcode = 'P0001', message = 'Нарушена изоляция складского каталога';
  end if;

  if p_entity = 'warehouses' then
    select exists (
      select 1 from records
      where coalesce(data->>'businessId', data->>'unit') = v_business and (
        (entity = 'stockMovements' and v_id in (data->>'warehouseId', data->>'fromWarehouseId', data->>'toWarehouseId'))
        or (entity in ('reservations', 'inventories') and data->>'warehouseId' = v_id)
        or (entity = 'stockBalances' and data->>'warehouseId' = v_id)
      )
    ) into v_has_reference;
  else
    select exists (
      select 1 from records
      where coalesce(data->>'businessId', data->>'unit') = v_business and (
        (entity in ('stockMovements', 'reservations') and data->>'stockItemId' = v_id)
        or (entity = 'inventories' and exists (
          select 1 from jsonb_array_elements(coalesce(data->'items', '[]'::jsonb)) line
          where line->>'stockItemId' = v_id
        ))
        or (entity = 'stockBalances' and data->>'stockItemId' = v_id)
      )
    ) into v_has_reference;
  end if;
  if v_has_reference then
    raise exception using errcode = 'P0001', message = 'Нельзя удалить: по записи есть складская история или остаток';
  end if;
  delete from records where entity = p_entity and id = v_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function stock_apply_reservation(p_before jsonb, p_after jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_has_before boolean := p_before is not null and jsonb_typeof(p_before) <> 'null';
  v_has_after boolean := p_after is not null and jsonb_typeof(p_after) <> 'null';
  v_requested jsonb := case when p_after is not null and jsonb_typeof(p_after) <> 'null' then p_after else p_before end;
  v_id text;
  v_existing jsonb;
  v_exists boolean;
  v_business text;
  v_warehouse text;
  v_item text;
  v_balance_id text;
  v_balance jsonb;
  v_old numeric := 0;
  v_new numeric := 0;
  v_reserved numeric;
  v_quantity numeric;
  v_now bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_inserted integer;
begin
  if not v_has_before and not v_has_after then
    raise exception using errcode = 'P0001', message = 'Не указан резерв';
  end if;
  v_id := coalesce(v_requested->>'id', '');
  if v_id = '' then
    raise exception using errcode = 'P0001', message = 'Не указан ID резерва';
  end if;

  if not v_has_before then
    insert into records(entity, id, data) values ('reservations', v_id, p_after)
    on conflict (entity, id) do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 0 then
      raise exception using errcode = 'P0001', message = 'Резерв с таким ID уже существует';
    end if;
    v_exists := false;
  else
    select data into v_existing from records
    where entity = 'reservations' and id = v_id for update;
    v_exists := found;
    if not v_exists then
      raise exception using errcode = 'P0001', message = 'Резерв не найден';
    end if;
  end if;

  if v_exists then
    v_business := coalesce(v_existing->>'businessId', v_existing->>'unit', '');
    v_warehouse := coalesce(v_existing->>'warehouseId', '');
    v_item := coalesce(v_existing->>'stockItemId', '');
    if v_existing->>'status' = 'active' then v_old := coalesce((v_existing->>'quantity')::numeric, 0); end if;
    if v_has_after and v_existing->>'status' = 'released' then
      raise exception using errcode = 'P0001', message = 'Освобождённый резерв нельзя изменять';
    end if;
  else
    v_business := coalesce(p_after->>'businessId', p_after->>'unit', '');
    v_warehouse := coalesce(p_after->>'warehouseId', '');
    v_item := coalesce(p_after->>'stockItemId', '');
  end if;

  if v_business = '' then raise exception using errcode = 'P0001', message = 'Не указан бизнес'; end if;
  if v_has_after then
    if p_after->>'id' is distinct from v_id
        or p_after->>'businessId' is distinct from v_business
        or p_after->>'unit' is distinct from v_business
        or p_after->>'warehouseId' is distinct from v_warehouse
        or p_after->>'stockItemId' is distinct from v_item then
      raise exception using errcode = 'P0001', message = 'Нельзя перенести резерв в другой бизнес, склад или позицию';
    end if;
    if coalesce(p_after->>'status', '') not in ('active', 'released') then
      raise exception using errcode = 'P0001', message = 'Неизвестный статус резерва';
    end if;
    begin v_new := (p_after->>'quantity')::numeric;
    exception when others then
      raise exception using errcode = 'P0001', message = 'Количество резерва должно быть больше нуля';
    end;
    if v_new is null or v_new <= 0 then
      raise exception using errcode = 'P0001', message = 'Количество резерва должно быть больше нуля';
    end if;
    if p_after->>'status' = 'released' then v_new := 0; end if;
  end if;

  perform 1 from records
  where (entity = 'warehouses' and id = v_warehouse)
     or (entity = 'stockItems' and id = v_item)
  order by entity, id for update;

  if not exists (
    select 1 from records where entity = 'warehouses' and id = v_warehouse
      and coalesce(data->>'businessId', data->>'unit') = v_business
      and (not v_has_after or data->>'active' is distinct from 'false')
  ) or not exists (
    select 1 from records where entity = 'stockItems' and id = v_item
      and coalesce(data->>'businessId', data->>'unit') = v_business
      and (not v_has_after or data->>'active' is distinct from 'false')
  ) then
    raise exception using errcode = 'P0001', message = 'Склад или позиция не найдены в этом бизнесе';
  end if;

  v_balance_id := 'stock-balance-' || v_warehouse || '::' || v_item;
  insert into records(entity, id, data) values (
    'stockBalances', v_balance_id, jsonb_build_object(
      'id', v_balance_id, 'businessId', v_business, 'unit', v_business,
      'warehouseId', v_warehouse, 'stockItemId', v_item,
      'quantity', 0, 'reserved', 0, 'created', v_now
    )
  ) on conflict (entity, id) do nothing;
  select data into strict v_balance from records
  where entity = 'stockBalances' and id = v_balance_id for update;
  if coalesce(v_balance->>'businessId', v_balance->>'unit') <> v_business
      or v_balance->>'warehouseId' is distinct from v_warehouse
      or v_balance->>'stockItemId' is distinct from v_item then
    raise exception using errcode = 'P0001', message = 'Нарушена изоляция складского остатка';
  end if;
  v_reserved := coalesce((v_balance->>'reserved')::numeric, 0) - v_old + v_new;
  v_quantity := coalesce((v_balance->>'quantity')::numeric, 0);
  if v_reserved < 0 then raise exception using errcode = 'P0001', message = 'Резерв уже освобождён'; end if;
  if v_reserved > v_quantity then raise exception using errcode = 'P0001', message = 'Недостаточно свободного остатка'; end if;
  update records set data = jsonb_set(
    jsonb_set(data, '{reserved}', to_jsonb(v_reserved), true),
    '{updated}', to_jsonb(v_now), true
  ) where entity = 'stockBalances' and id = v_balance_id;
  if v_has_after then
    update records set data = p_after where entity = 'reservations' and id = v_id;
  else
    delete from records where entity = 'reservations' and id = v_id;
  end if;
  return jsonb_build_object('ok', true, 'item', case when v_has_after then p_after else null end);
end $$;

revoke all on function stock_apply_movement(jsonb) from public, anon, authenticated;
revoke all on function stock_apply_reservation(jsonb, jsonb) from public, anon, authenticated;
revoke all on function stock_complete_inventory(jsonb, boolean, jsonb) from public, anon, authenticated;
revoke all on function stock_save_inventory(jsonb, jsonb) from public, anon, authenticated;
revoke all on function stock_delete_catalog(text, jsonb) from public, anon, authenticated;
grant execute on function stock_apply_movement(jsonb) to service_role;
grant execute on function stock_apply_reservation(jsonb, jsonb) to service_role;
grant execute on function stock_complete_inventory(jsonb, boolean, jsonb) to service_role;
grant execute on function stock_save_inventory(jsonb, jsonb) to service_role;
grant execute on function stock_delete_catalog(text, jsonb) to service_role;

notify pgrst, 'reload schema';
