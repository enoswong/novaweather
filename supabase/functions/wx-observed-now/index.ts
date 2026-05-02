// 修改說明：提供 /wx/observed/now 對外 API（MVP 以最近小時資料近似 current）
// 影響文件：supabase/functions/wx-observed-now/index.ts

import { jsonError, jsonResponse } from "../_shared/wx/http.ts";
import { getSupabaseAdminClient } from "../_shared/wx/supabase.ts";
import { resolveLocationFromRequest } from "../_shared/wx/location.ts";

Deno.serve(async (req) => {
  try {
    if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
    const url = new URL(req.url);
    const supabase = getSupabaseAdminClient();
    const loc = await resolveLocationFromRequest({ url, supabase, geohashPrecision: 6 });
    const geohash = loc.geohash;

    const { data, error } = await supabase
      .from("wx_hourly_series")
      .select("*")
      .eq("geohash", geohash)
      .eq("kind", "observed")
      .order("valid_time", { ascending: false })
      .limit(1);
    if (error) throw error;

    const row = (data ?? [])[0] ?? null;

    return jsonResponse({
      meta: {
        fetched_at: new Date().toISOString(),
        lat: loc.lat,
        lon: loc.lon,
        geohash,
        place_id: loc.place_id,
        country_code: loc.country_code,
        admin1: loc.admin1,
        admin2: loc.admin2,
        admin3: loc.admin3,
        admin4: loc.admin4,
        locality: loc.locality,
        name: loc.name,
      },
      observed: row
        ? {
          valid_time: row.valid_time,
          temp_c: row.temp_c,
          feels_like_c: row.feels_like_c,
          humidity_pct: row.humidity_pct,
          dewpoint_c: row.dewpoint_c,
          pressure_hpa: row.pressure_hpa,
          wind_ms: row.wind_ms,
          wind_dir_deg: row.wind_dir_deg,
          gust_ms: row.gust_ms,
          precip_mm: row.precip_mm,
          precip_prob: row.precip_prob,
          snow_mm: row.snow_mm,
          cloud_pct: row.cloud_pct,
          visibility_m: row.visibility_m,
          uv_index: row.uv_index,
          provider: row.provider,
          fetched_at: row.fetched_at,
          confidence: row.confidence,
        }
        : null,
    });
  } catch (e) {
    return jsonError(e);
  }
});

