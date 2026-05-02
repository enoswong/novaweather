-- 修改說明：建立全球天氣後端 wx_* 基礎資料表、索引與擴充套件
-- 影響文件：supabase/migrations/20260430150000_init_wx_schema.sql

begin;

-- Extensions (可視需要調整；pgcrypto 用於 gen_random_uuid)
create extension if not exists pgcrypto;

-- ---------------------------------------------
-- wx_locations：地點/分格
-- ---------------------------------------------
create table if not exists public.wx_locations (
  id uuid primary key default gen_random_uuid(),
  lat double precision not null,
  lon double precision not null,
  geohash text not null,
  timezone text not null,
  country_code text null,
  admin1 text null,
  name text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists wx_locations_geohash_uq on public.wx_locations (geohash);
create index if not exists wx_locations_lat_lon_idx on public.wx_locations (lat, lon);

-- ---------------------------------------------
-- wx_cache：快取（直接存對外回應 payload）
-- ---------------------------------------------
create table if not exists public.wx_cache (
  cache_key text primary key,
  geohash text not null,
  endpoint text not null,
  params jsonb not null default '{}'::jsonb,
  payload jsonb not null,
  fetched_at timestamptz not null,
  expires_at timestamptz not null
);

create index if not exists wx_cache_geohash_endpoint_idx on public.wx_cache (geohash, endpoint);
create index if not exists wx_cache_expires_at_idx on public.wx_cache (expires_at);

-- ---------------------------------------------
-- wx_hourly_series：小時級時間序列（observed/forecast）
-- ---------------------------------------------
create table if not exists public.wx_hourly_series (
  geohash text not null,
  valid_time timestamptz not null,
  kind text not null check (kind in ('observed','forecast')),

  temp_c double precision null,
  feels_like_c double precision null,
  humidity_pct double precision null,
  dewpoint_c double precision null,
  pressure_hpa double precision null,

  wind_ms double precision null,
  wind_dir_deg double precision null,
  gust_ms double precision null,

  precip_mm double precision null,
  precip_prob double precision null,
  snow_mm double precision null,

  cloud_pct double precision null,
  visibility_m double precision null,
  uv_index double precision null,

  provider text not null,
  fetched_at timestamptz not null,
  confidence double precision null,

  primary key (geohash, valid_time, kind, provider)
);

create index if not exists wx_hourly_series_geohash_time_desc_idx
  on public.wx_hourly_series (geohash, valid_time desc);
create index if not exists wx_hourly_series_kind_idx
  on public.wx_hourly_series (kind);

-- ---------------------------------------------
-- wx_daily_series：日級序列（YYYY-MM-DD）
-- ---------------------------------------------
create table if not exists public.wx_daily_series (
  geohash text not null,
  date date not null,

  t_min_c double precision null,
  t_max_c double precision null,
  precip_sum_mm double precision null,
  precip_prob_max double precision null,
  wind_max_ms double precision null,
  uv_max double precision null,

  provider text not null,
  fetched_at timestamptz not null,
  confidence double precision null,

  primary key (geohash, date, provider)
);

create index if not exists wx_daily_series_geohash_date_desc_idx
  on public.wx_daily_series (geohash, date desc);

-- ---------------------------------------------
-- wx_alerts：事件/警報（先不強制 PostGIS）
-- ---------------------------------------------
create table if not exists public.wx_alerts (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  severity text not null check (severity in ('info','yellow','orange','red','emergency')),
  title text not null,
  description text null,
  starts_at timestamptz null,
  ends_at timestamptz null,
  -- MVP：先用 bbox + geohash_prefixes，後續可再升級為 PostGIS geography
  bbox jsonb null,
  geohash_prefixes text[] null,
  raw jsonb null,
  created_at timestamptz not null default now()
);

create index if not exists wx_alerts_source_starts_at_idx on public.wx_alerts (source, starts_at);
create index if not exists wx_alerts_ends_at_idx on public.wx_alerts (ends_at);

-- ---------------------------------------------
-- wx_risk_snapshots：風險/變化偵測結果（可用於趨勢與訓練）
-- ---------------------------------------------
create table if not exists public.wx_risk_snapshots (
  geohash text not null,
  computed_at timestamptz not null,
  window_hours integer not null,
  risk_level integer not null check (risk_level between 0 and 3),
  reasons jsonb not null default '[]'::jsonb,
  primary key (geohash, computed_at, window_hours)
);

create index if not exists wx_risk_snapshots_geohash_time_desc_idx
  on public.wx_risk_snapshots (geohash, computed_at desc);

-- ---------------------------------------------
-- 可觀測性/熔斷
-- ---------------------------------------------
create table if not exists public.wx_ingest_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  geohash text not null,
  endpoint text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  latency_ms integer null,
  status text not null check (status in ('ok','error','skipped')),
  http_status integer null,
  error text null,
  quota_remaining integer null
);

create index if not exists wx_ingest_runs_provider_started_at_desc_idx
  on public.wx_ingest_runs (provider, started_at desc);
create index if not exists wx_ingest_runs_geohash_started_at_desc_idx
  on public.wx_ingest_runs (geohash, started_at desc);

create table if not exists public.wx_provider_health (
  provider text primary key,
  failure_rate_15m numeric null,
  p95_latency_ms integer null,
  circuit_open_until timestamptz null,
  updated_at timestamptz not null default now()
);

commit;

