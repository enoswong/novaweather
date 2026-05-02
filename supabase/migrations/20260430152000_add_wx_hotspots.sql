-- 修改說明：新增 wx_hotspots 熱點表，供排程預取使用
-- 影響文件：supabase/migrations/20260430152000_add_wx_hotspots.sql

begin;

create table if not exists public.wx_hotspots (
  geohash text primary key,
  lat double precision not null,
  lon double precision not null,
  priority integer not null default 0,
  last_refresh_hourly_at timestamptz null,
  last_refresh_daily_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists wx_hotspots_priority_desc_idx
  on public.wx_hotspots (priority desc, created_at desc);

alter table public.wx_hotspots enable row level security;

drop policy if exists "wx_hotspots_read" on public.wx_hotspots;
create policy "wx_hotspots_read"
on public.wx_hotspots
for select
to anon, authenticated
using (true);

commit;

