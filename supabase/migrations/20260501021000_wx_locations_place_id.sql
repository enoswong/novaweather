-- 修改說明：為 wx_locations 加入 place_id/admin2 與查詢索引，支援以國家/地區細化與精準位置引用
-- 影響文件：supabase/migrations/20260501021000_wx_locations_place_id.sql

begin;

alter table public.wx_locations
  add column if not exists place_id text null,
  add column if not exists admin2 text null;

create unique index if not exists wx_locations_place_id_uq
  on public.wx_locations (place_id)
  where place_id is not null;

create index if not exists wx_locations_country_admin1_idx
  on public.wx_locations (country_code, admin1);

commit;

