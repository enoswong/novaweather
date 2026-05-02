-- 修改說明：固定 wx_alerts_nearby 的 search_path，回應 Supabase advisor 的 function_search_path_mutable 警告
-- 影響文件：supabase/migrations/20260501024000_secure_wx_alerts_nearby_search_path.sql

alter function public.wx_alerts_nearby(double precision, double precision, integer)
  set search_path = public, extensions;

alter function public.wx_alerts_nearby(double precision, double precision, integer, integer)
  set search_path = public, extensions;

