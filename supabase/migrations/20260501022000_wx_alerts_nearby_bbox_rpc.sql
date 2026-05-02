-- 修改說明：新增 wx_alerts_nearby_bbox RPC，提供不依賴 PostGIS 的附近 alerts 粗略過濾（以 bbox 交集判斷）
-- 影響文件：supabase/migrations/20260501022000_wx_alerts_nearby_bbox_rpc.sql

begin;

-- bbox 格式約定（jsonb）：
-- { "min_lat": <number>, "min_lon": <number>, "max_lat": <number>, "max_lon": <number> }
-- 若 bbox 為 null，代表無可用地理範圍（插件/來源未提供），此 RPC 會保留該筆（避免誤刪）。

create or replace function public.wx_alerts_nearby_bbox(
  in_lat double precision,
  in_lon double precision,
  in_radius_km integer default 50
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
with params as (
  select
    greatest(1, least(in_radius_km, 500))::double precision as r_km,
    in_lat::double precision as lat,
    in_lon::double precision as lon
),
b as (
  select
    lat,
    lon,
    r_km,
    (r_km / 111.0) as dlat,
    (r_km / (111.0 * greatest(0.1, cos(radians(lat))))) as dlon
  from params
),
active as (
  select *
  from public.wx_alerts
  where ends_at is null or ends_at > now()
)
select
  a.id,
  a.source,
  a.severity,
  a.title,
  a.description,
  a.starts_at,
  a.ends_at
from active a
cross join b
where
  a.bbox is null
  or (
    -- bbox intersects query bbox
    (coalesce((a.bbox->>'max_lat')::double precision, 90) >= (b.lat - b.dlat))
    and (coalesce((a.bbox->>'min_lat')::double precision, -90) <= (b.lat + b.dlat))
    and (coalesce((a.bbox->>'max_lon')::double precision, 180) >= (b.lon - b.dlon))
    and (coalesce((a.bbox->>'min_lon')::double precision, -180) <= (b.lon + b.dlon))
  )
order by a.starts_at desc nulls last
limit 200;
$$;

grant execute on function public.wx_alerts_nearby_bbox(double precision, double precision, integer) to anon, authenticated;

commit;

