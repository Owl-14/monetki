-- Ежечасная синхронизация с Точка Банком.
-- Миграция идемпотентна: удаляет все старые задания с тем же именем
-- и создаёт ровно одно с достаточным таймаутом для долгой синхронизации.
select cron.unschedule(jobid)
from cron.job
where jobname = 'tochka-sync-hourly';

select cron.schedule(
  'tochka-sync-hourly',
  '5 * * * *',
  $$
  select net.http_post(
    url := 'https://pmntdxwdsrdtaindabqb.supabase.co/functions/v1/api',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{"action":"tochka_sync"}'::jsonb,
    timeout_milliseconds := 180000
  )
  $$
);
