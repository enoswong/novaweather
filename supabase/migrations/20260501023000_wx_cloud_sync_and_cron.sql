-- 修改說明：同步雲端 novaweather schema，補齊精準位置欄位、CAP feed 欄位、PostGIS nearby RPC 與 pg_cron/pg_net 排程
-- 影響文件：supabase/migrations/20260501023000_wx_cloud_sync_and_cron.sql

begin;

create extension if not exists postgis;
create extension if not exists pg_net;
create extension if not exists pg_cron;

alter table public.wx_locations
  add column if not exists place_id text null,
  add column if not exists admin2 text null,
  add column if not exists admin3 text null,
  add column if not exists admin4 text null,
  add column if not exists locality text null;

create unique index if not exists wx_locations_place_id_uq
  on public.wx_locations (place_id)
  where place_id is not null;

create index if not exists wx_locations_country_admin1_idx
  on public.wx_locations (country_code, admin1);

create index if not exists wx_locations_country_admin12_idx
  on public.wx_locations (country_code, admin1, admin2);

alter table public.wx_alerts
  add column if not exists area geography(Geometry, 4326) null,
  add column if not exists area_center geography(Point, 4326) null,
  add column if not exists country_code text null,
  add column if not exists region_code text null,
  add column if not exists event_type text null,
  add column if not exists ext_id text null,
  add column if not exists sent_at timestamptz null,
  add column if not exists updated_at timestamptz null;

create index if not exists wx_alerts_area_gix on public.wx_alerts using gist (area);
create index if not exists wx_alerts_area_center_gix on public.wx_alerts using gist (area_center);
create unique index if not exists wx_alerts_source_ext_id_uq
  on public.wx_alerts (source, ext_id)
  where ext_id is not null;

create table if not exists public.wx_alert_feeds (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  country_code text null,
  region_code text null,
  url text not null,
  is_enabled boolean not null default true,
  last_fetched_at timestamptz null,
  created_at timestamptz not null default now()
);

alter table public.wx_alert_feeds enable row level security;

drop policy if exists "wx_alert_feeds_read" on public.wx_alert_feeds;
create policy "wx_alert_feeds_read"
on public.wx_alert_feeds
for select
to anon, authenticated
using (true);

create or replace function public.wx_alerts_nearby(
  in_lat double precision,
  in_lon double precision,
  in_radius_m integer default 50000
)
returns table (
  id uuid,
  source text,
  severity text,
  title text,
  description text,
  starts_at timestamptz,
  ends_at timestamptz
)
language sql
stable
as $$
  select
    a.id,
    a.source,
    a.severity,
    a.title,
    a.description,
    a.starts_at,
    a.ends_at
  from public.wx_alerts a
  where (a.ends_at is null or a.ends_at > now())
    and (
      a.area_center is null
      or st_dwithin(
        a.area_center,
        st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography,
        greatest(1000, least(in_radius_m, 500000))
      )
      or (
        a.area is not null
        and st_dwithin(
          a.area,
          st_setsrid(st_makepoint(in_lon, in_lat), 4326)::geography,
          greatest(1000, least(in_radius_m, 500000))
        )
      )
    )
  order by a.starts_at desc nulls last
  limit 200;
$$;

grant execute on function public.wx_alerts_nearby(double precision, double precision, integer) to anon, authenticated;

insert into public.wx_alert_feeds (source, country_code, region_code, url)
values
  ('NWS', 'US', null, 'https://api.weather.gov/alerts/active.atom'),
  ('MeteoAlarm', 'EU', null, 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-europe'),
  ('EnvironmentCanada', 'CA', null, 'https://weather.gc.ca/rss/battleboard/canada_e.xml')
on conflict do nothing;

commit;

-- Best-effort scheduled Edge Function calls. These functions are deployed with verify_jwt=false in this project.
select cron.unschedule(jobname)
from cron.job
where jobname in (
  'novaweather_refresh_hotspots_hourly',
  'novaweather_refresh_hotspots_daily',
  'novaweather_observed_refresh_hotspots',
  'novaweather_alerts_ingest_cap',
  'novaweather_alerts_ingest_hko',
  'novaweather_alerts_ingest_smg',
  'novaweather_provider_health_refresh',
  'novaweather_cleanup_expired_cache',
  'novaweather_prune_time_series',
  'novaweather_alerts_prune'
);

select cron.schedule(
  'novaweather_refresh_hotspots_hourly',
  '*/30 * * * *',
  $$select net.http_post(url := 'https://whajwzbqracxpydpooyp.supabase.co/functions/v1/wx-refresh-hotspots-hourly', body := '{}'::jsonb);$$
);

select cron.schedule(
  'novaweather_refresh_hotspots_daily',
  '0 */6 * * *',
  $$select net.http_post(url := 'https://whajwzbqracxpydpooyp.supabase.co/functions/v1/wx-refresh-hotspots-daily', body := '{}'::jsonb);$$
);

select cron.schedule(
  'novaweather_observed_refresh_hotspots',
  '*/15 * * * *',
  $$select net.http_post(url := 'https://whajwzbqracxpydpooyp.supabase.co/functions/v1/wx-observed-refresh-hotspots', body := '{}'::jsonb);$$
);

select cron.schedule(
  'novaweather_alerts_ingest_cap',
  '*/10 * * * *',
  $$select net.http_post(url := 'https://whajwzbqracxpydpooyp.supabase.co/functions/v1/wx-alerts-ingest-cap', body := '{}'::jsonb);$$
);

select cron.schedule(
  'novaweather_alerts_ingest_hko',
  '*/5 * * * *',
  $$select net.http_post(url := 'https://whajwzbqracxpydpooyp.supabase.co/functions/v1/wx-alerts-ingest-hko', body := '{}'::jsonb);$$
);

select cron.schedule(
  'novaweather_alerts_ingest_smg',
  '*/10 * * * *',
  $$select net.http_post(url := 'https://whajwzbqracxpydpooyp.supabase.co/functions/v1/wx-alerts-ingest-smg', body := '{}'::jsonb);$$
);

select cron.schedule(
  'novaweather_provider_health_refresh',
  '*/5 * * * *',
  $$select net.http_post(url := 'https://whajwzbqracxpydpooyp.supabase.co/functions/v1/wx-provider-health-refresh', body := '{}'::jsonb);$$
);

select cron.schedule(
  'novaweather_cleanup_expired_cache',
  '17 * * * *',
  $$select net.http_post(url := 'https://whajwzbqracxpydpooyp.supabase.co/functions/v1/wx-cleanup-expired-cache', body := '{}'::jsonb);$$
);

select cron.schedule(
  'novaweather_prune_time_series',
  '41 2 * * *',
  $$select net.http_post(url := 'https://whajwzbqracxpydpooyp.supabase.co/functions/v1/wx-prune-time-series', body := '{}'::jsonb);$$
);

select cron.schedule(
  'novaweather_alerts_prune',
  '53 2 * * *',
  $$select net.http_post(url := 'https://whajwzbqracxpydpooyp.supabase.co/functions/v1/wx-alerts-prune', body := '{"keep_days":30}'::jsonb);$$
);

