-- Убирает сложный движок банковских правил из MON-010 (009_bank_rules.sql).
-- Его триггер блокировал любые правки банковских операций, а синхронизация
-- падала целиком на одной операции. Вместо него — простые правила bankAutoRules
-- в коде функции api. Миграция идемпотентна и применяется при каждом deploy.
-- Старые записи bankRules/bankRuleApplications/... не удаляются: они просто не читаются.

drop trigger if exists bank_rules_protect_records_trigger on public.records;
drop function if exists public.bank_rules_protect_records();

drop function if exists public.restore_monetki_backup(jsonb);
drop function if exists public.bank_rule_restore_graph(jsonb);
drop function if exists public.reverse_bank_rule_transaction(text, text, text);
drop function if exists public.correct_bank_rule_transaction(text, jsonb, text, text);
drop function if exists public.apply_bank_rule_transaction(jsonb);
drop function if exists public.bank_rule_append_run(jsonb);
drop function if exists public.bank_rule_settings_save(jsonb, integer, text);
drop function if exists public.bank_rule_save(jsonb, integer, text);
drop function if exists public.bank_enqueue_transaction(jsonb);

-- Операции, которые в старой очереди пометили «Игнорировать», остаются скрытыми.
update public.records
set data = data || jsonb_build_object('ignored', true)
where entity = 'bankTransactions'
  and data->>'bankRuleState' = 'ignored'
  and coalesce(data->>'ignored', '') <> 'true';

notify pgrst, 'reload schema';
