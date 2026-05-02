-- 修改說明：加入 region_code 同步排程，讓 country/region 映射定期刷新
-- 影響文件：supabase/migrations/20260501052000_schedule_region_code_sync.sql

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobname)
from cron.job
where jobname in ('novaweather_sync_region_codes');

select cron.schedule(
  'novaweather_sync_region_codes',
  '*/30 * * * *',
  $$select net.http_post(url := 'https://whajwzbqracxpydpooyp.supabase.co/functions/v1/wx-sync-region-codes', body := '{}'::jsonb);$$
);

