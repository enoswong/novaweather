-- 修改說明：新增 region_code 映射表與區域 API 快取表，並由 wx_locations 初始化映射資料
-- 影響文件：supabase/migrations/20260501050000_add_region_mapping_and_cache.sql

begin;

create table if not exists public.wx_region_codes (
  id bigserial primary key,
  country_code text not null,
  region_code text not null,
  region_name text not null,
  geohash text not null,
  place_id text null,
  lat double precision not null,
  lon double precision not null,
  timezone text not null default 'UTC',
  admin1 text null,
  admin2 text null,
  admin3 text null,
  admin4 text null,
  locality text null,
  name text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (country_code, region_code),
  unique (geohash)
);

create index if not exists wx_region_codes_country_idx
  on public.wx_region_codes (country_code);

create index if not exists wx_region_codes_country_admin_idx
  on public.wx_region_codes (country_code, admin1, admin2, admin3, admin4, locality);

create table if not exists public.wx_region_cache (
  cache_key text primary key,
  country_code text not null,
  region_code text null,
  granularity text not null,
  payload jsonb not null,
  fetched_at timestamptz not null,
  expires_at timestamptz not null
);

create index if not exists wx_region_cache_country_region_idx
  on public.wx_region_cache (country_code, region_code, granularity);

create index if not exists wx_region_cache_expires_at_idx
  on public.wx_region_cache (expires_at);

insert into public.wx_region_codes (
  country_code,
  region_code,
  region_name,
  geohash,
  place_id,
  lat,
  lon,
  timezone,
  admin1,
  admin2,
  admin3,
  admin4,
  locality,
  name,
  updated_at
)
select
  l.country_code,
  (
    lower(
      regexp_replace(
        coalesce(nullif(l.locality, ''), nullif(l.admin4, ''), nullif(l.admin3, ''), nullif(l.admin2, ''), nullif(l.admin1, ''), nullif(l.name, ''), l.geohash),
        '[^a-zA-Z0-9]+',
        '-',
        'g'
      )
    ) || '-' || left(l.geohash, 4)
  ) as region_code,
  coalesce(nullif(l.locality, ''), nullif(l.admin4, ''), nullif(l.admin3, ''), nullif(l.admin2, ''), nullif(l.admin1, ''), nullif(l.name, ''), l.geohash) as region_name,
  l.geohash,
  l.place_id,
  l.lat,
  l.lon,
  coalesce(nullif(l.timezone, ''), 'UTC') as timezone,
  l.admin1,
  l.admin2,
  l.admin3,
  l.admin4,
  l.locality,
  l.name,
  now()
from public.wx_locations l
where l.country_code is not null
  and l.geohash is not null
on conflict (geohash) do update
set
  country_code = excluded.country_code,
  region_code = excluded.region_code,
  region_name = excluded.region_name,
  place_id = excluded.place_id,
  lat = excluded.lat,
  lon = excluded.lon,
  timezone = excluded.timezone,
  admin1 = excluded.admin1,
  admin2 = excluded.admin2,
  admin3 = excluded.admin3,
  admin4 = excluded.admin4,
  locality = excluded.locality,
  name = excluded.name,
  updated_at = now();

insert into public.wx_region_codes (
  country_code, region_code, region_name, geohash, place_id, lat, lon, timezone, admin1, admin2, admin3, admin4, locality, name, updated_at
)
values
  ('HK', 'hong-kong-central-wecnyk', 'Hong Kong Central', 'wecnyk', 'seed:hk:central', 22.306927, 114.183064, 'Asia/Hong_Kong', 'Hong Kong', null, null, null, null, 'Hong Kong', now()),
  ('CN', 'shenzhen-nanshan-ws1078', 'Shenzhen Nanshan', 'ws1078', 'seed:cn:shenzhen', 22.548097, 114.061154, 'Asia/Shanghai', 'Guangdong', 'Shenzhen', null, null, 'Nanshan', 'Shenzhen', now()),
  ('MO', 'macau-urban-ws0e9t', 'Macau Urban', 'ws0e9t', 'seed:mo:urban', 22.198745, 113.543873, 'Asia/Macau', 'Macau', null, null, null, null, 'Macau', now()),
  ('TW', 'taipei-city-wsqqqq', 'Taipei City', 'wsqqqq', 'seed:tw:taipei', 25.033000, 121.565400, 'Asia/Taipei', 'Taipei', null, null, null, null, 'Taipei', now()),
  ('JP', 'tokyo-chiyoda-xn774c', 'Tokyo Chiyoda', 'xn774c', 'seed:jp:tokyo', 35.689500, 139.691700, 'Asia/Tokyo', 'Tokyo', 'Chiyoda', null, null, null, 'Tokyo', now()),
  ('US', 'new-york-manhattan-dr5reg', 'New York Manhattan', 'dr5reg', 'seed:us:nyc', 40.712800, -74.006000, 'America/New_York', 'New York', 'New York County', null, null, 'Manhattan', 'New York', now())
on conflict (geohash) do update
set
  country_code = excluded.country_code,
  region_code = excluded.region_code,
  region_name = excluded.region_name,
  place_id = excluded.place_id,
  lat = excluded.lat,
  lon = excluded.lon,
  timezone = excluded.timezone,
  admin1 = excluded.admin1,
  admin2 = excluded.admin2,
  admin3 = excluded.admin3,
  admin4 = excluded.admin4,
  locality = excluded.locality,
  name = excluded.name,
  updated_at = now();

commit;

