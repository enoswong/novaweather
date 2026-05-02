-- 修改說明：為 wx_* 表啟用 RLS，預設「公共讀、受控寫」
-- 影響文件：supabase/migrations/20260430151000_init_wx_rls.sql

begin;

alter table public.wx_locations enable row level security;
alter table public.wx_cache enable row level security;
alter table public.wx_hourly_series enable row level security;
alter table public.wx_daily_series enable row level security;
alter table public.wx_alerts enable row level security;
alter table public.wx_risk_snapshots enable row level security;
alter table public.wx_ingest_runs enable row level security;
alter table public.wx_provider_health enable row level security;

-- Public read policies (anon/auth) — 天氣資料可公開讀
drop policy if exists "wx_locations_read" on public.wx_locations;
create policy "wx_locations_read"
on public.wx_locations
for select
to anon, authenticated
using (true);

drop policy if exists "wx_cache_read" on public.wx_cache;
create policy "wx_cache_read"
on public.wx_cache
for select
to anon, authenticated
using (true);

drop policy if exists "wx_hourly_series_read" on public.wx_hourly_series;
create policy "wx_hourly_series_read"
on public.wx_hourly_series
for select
to anon, authenticated
using (true);

drop policy if exists "wx_daily_series_read" on public.wx_daily_series;
create policy "wx_daily_series_read"
on public.wx_daily_series
for select
to anon, authenticated
using (true);

drop policy if exists "wx_alerts_read" on public.wx_alerts;
create policy "wx_alerts_read"
on public.wx_alerts
for select
to anon, authenticated
using (true);

drop policy if exists "wx_risk_snapshots_read" on public.wx_risk_snapshots;
create policy "wx_risk_snapshots_read"
on public.wx_risk_snapshots
for select
to anon, authenticated
using (true);

-- Observability tables：對外可讀（如需收緊，可改為僅 Edge Functions 代理）
drop policy if exists "wx_ingest_runs_read" on public.wx_ingest_runs;
create policy "wx_ingest_runs_read"
on public.wx_ingest_runs
for select
to anon, authenticated
using (true);

drop policy if exists "wx_provider_health_read" on public.wx_provider_health;
create policy "wx_provider_health_read"
on public.wx_provider_health
for select
to anon, authenticated
using (true);

-- No public write policies — 寫入只允許 service role / Edge Functions (繞過 RLS)
commit;

