-- 修改說明：擴充 wx_locations 行政區層級到更細（locality/admin3/admin4），支援「香港/天水圍」、「廣東/深圳/寶安」等輸入/輸出
-- 影響文件：supabase/migrations/20260501022500_wx_locations_admin34.sql

begin;

alter table public.wx_locations
  add column if not exists locality text null,
  add column if not exists admin3 text null,
  add column if not exists admin4 text null;

create index if not exists wx_locations_country_admin12_idx
  on public.wx_locations (country_code, admin1, admin2);

commit;

