// 修改說明：提供 /wx/alerts 對外 API（MVP 從 wx_alerts 讀取；無資料回空陣列）
// 影響文件：supabase/functions/wx-alerts/index.ts

import { jsonError, jsonResponse } from "../_shared/wx/http.ts";
import { clampInt } from "../_shared/wx/validate.ts";
import { getSupabaseAdminClient } from "../_shared/wx/supabase.ts";
import { resolveLocationFromRequest } from "../_shared/wx/location.ts";

Deno.serve(async (req) => {
  try {
    if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
    const url = new URL(req.url);
    const radiusParam = url.searchParams.get("radius_km");
    const radius_km = clampInt(radiusParam == null ? 50 : Number(radiusParam), 1, 500, "radius_km");

    const supabase = getSupabaseAdminClient();
    const loc = await resolveLocationFromRequest({ url, supabase, geohashPrecision: 6 });

    const { data, error } = await supabase.rpc("wx_alerts_nearby", {
      in_lat: loc.lat,
      in_lon: loc.lon,
      in_radius_m: radius_km * 1000,
    });
    if (error) throw error;

    return jsonResponse({
      meta: {
        fetched_at: new Date().toISOString(),
        lat: loc.lat,
        lon: loc.lon,
        radius_km,
        place_id: loc.place_id,
        country_code: loc.country_code,
        admin1: loc.admin1,
        admin2: loc.admin2,
        admin3: loc.admin3,
        admin4: loc.admin4,
        locality: loc.locality,
        name: loc.name,
      },
      alerts: data ?? [],
    });
  } catch (e) {
    return jsonError(e);
  }
});

