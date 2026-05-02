// 修改說明：提供 /wx/risk 對外 API（rule-based baseline + alerts 加權 + 寫入 wx_risk_snapshots）
// 影響文件：supabase/functions/wx-risk/index.ts

import { jsonError, jsonResponse } from "../_shared/wx/http.ts";
import { fetchForecastWithProvider, defaultProviderPriority } from "../_shared/wx/provider_chain.ts";
import type { WxProvider, WxRiskReason, WxRiskResponse, WxHourlyPoint } from "../_shared/wx/types.ts";
import { clampInt } from "../_shared/wx/validate.ts";
import { getSupabaseAdminClient } from "../_shared/wx/supabase.ts";
import { resolveLocationFromRequest } from "../_shared/wx/location.ts";

function riskLevelFromReasons(reasons: WxRiskReason[]): 0 | 1 | 2 | 3 {
  let lvl: 0 | 1 | 2 | 3 = 0;
  for (const r of reasons) lvl = Math.max(lvl, r.severity) as 0 | 1 | 2 | 3;
  return lvl;
}

function safeNum(n: unknown): number | null {
  if (typeof n !== "number") return null;
  if (!Number.isFinite(n)) return null;
  return n;
}

function computeReasons(args: {
  windowHours: number;
  hourly: WxHourlyPoint[];
  activeAlertsCount: number;
}): WxRiskReason[] {
  const { windowHours, hourly, activeAlertsCount } = args;
  const reasons: WxRiskReason[] = [];

  const now = Date.now();
  const windowEnd = now + windowHours * 3600 * 1000;
  const points = hourly
    .map((p) => ({ ...p, t: new Date(p.valid_time).getTime() }))
    .filter((p) => Number.isFinite(p.t) && p.t >= now && p.t <= windowEnd)
    .sort((a, b) => a.t - b.t);

  const temps = points.map((p) => safeNum(p.temp_c)).filter((v): v is number => v != null);
  const hums = points.map((p) => safeNum(p.humidity_pct)).filter((v): v is number => v != null);
  const probs = points.map((p) => safeNum(p.precip_prob)).filter((v): v is number => v != null);
  const precips = points.map((p) => safeNum(p.precip_mm)).filter((v): v is number => v != null);
  const winds = points.map((p) => safeNum(p.wind_ms)).filter((v): v is number => v != null);
  const gusts = points.map((p) => safeNum(p.gust_ms)).filter((v): v is number => v != null);

  // A1 溫度驟降 > 4°C：用「當前第一點溫度 - 未來最小溫度」近似
  if (temps.length >= 2) {
    const current = temps[0];
    const minFuture = Math.min(...temps);
    const delta = current - minFuture;
    if (delta >= 4) {
      reasons.push({
        code: "temp_drop_gt_4c",
        severity: delta >= 7 ? 2 : 1,
        details: { delta_c: Number(delta.toFixed(1)), window_hours: windowHours },
      });
    }

    // A1 日夜溫差 > 8°C：用 window 內 max-min
    const range = Math.max(...temps) - Math.min(...temps);
    if (range >= 8) {
      reasons.push({
        code: "diurnal_temp_range_gt_8c",
        severity: range >= 12 ? 2 : 1,
        details: { range_c: Number(range.toFixed(1)), window_hours: windowHours },
      });
    }
  }

  // A3 濕度監測 >90 / <40（任何一點觸發）
  if (hums.some((h) => h >= 90)) {
    reasons.push({
      code: "humidity_gt_90",
      severity: 1,
      details: { max_humidity_pct: Math.max(...hums) },
    });
  }
  if (hums.some((h) => h <= 40)) {
    reasons.push({
      code: "humidity_lt_40",
      severity: 1,
      details: { min_humidity_pct: Math.min(...hums) },
    });
  }

  // A2 降水預警：高降水機率/強降雨（簡化）
  const maxProb = probs.length ? Math.max(...probs) : null;
  const maxPrecip = precips.length ? Math.max(...precips) : null;
  if ((maxProb != null && maxProb >= 0.6) || (maxPrecip != null && maxPrecip >= 10)) {
    reasons.push({
      code: "heavy_rain_prob",
      severity: (maxProb != null && maxProb >= 0.85) || (maxPrecip != null && maxPrecip >= 30) ? 2 : 1,
      details: { max_precip_prob: maxProb, max_precip_mm: maxPrecip },
    });
  }

  // 強風（簡化）：風速 >= 13.9m/s 或 陣風 >= 20m/s
  const maxWind = winds.length ? Math.max(...winds) : null;
  const maxGust = gusts.length ? Math.max(...gusts) : null;
  if ((maxWind != null && maxWind >= 13.9) || (maxGust != null && maxGust >= 20)) {
    reasons.push({
      code: "strong_wind",
      severity: (maxGust != null && maxGust >= 30) || (maxWind != null && maxWind >= 20) ? 2 : 1,
      details: { max_wind_ms: maxWind, max_gust_ms: maxGust },
    });
  }

  // 官方警報加權（先用「有無」；後續再做 geo filter）
  if (activeAlertsCount > 0) {
    reasons.push({
      code: "official_alert",
      severity: 2,
      details: { active_alerts: activeAlertsCount },
    });
  }

  return reasons;
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

    const url = new URL(req.url);
    const windowParam = url.searchParams.get("window_hours");
    const windowHours = clampInt(windowParam == null ? 24 : Number(windowParam), 1, 72, "window_hours");
    const radiusParam = url.searchParams.get("radius_km");
    const radiusKm = clampInt(radiusParam == null ? 50 : Number(radiusParam), 1, 500, "radius_km");

    const provider = (url.searchParams.get("provider") ?? "auto") as WxProvider;
    const supabase = getSupabaseAdminClient();
    const loc = await resolveLocationFromRequest({ url, supabase, geohashPrecision: 6 });
    const geohash = loc.geohash;

    // 先讀 DB 的 forecast 序列（若空再抓一次）
    const nowIso = new Date().toISOString();
    const endIso = new Date(Date.now() + windowHours * 3600 * 1000).toISOString();
    const { data: rows, error } = await supabase
      .from("wx_hourly_series")
      .select("valid_time,temp_c,feels_like_c,humidity_pct,dewpoint_c,pressure_hpa,wind_ms,wind_dir_deg,gust_ms,precip_mm,precip_prob,snow_mm,cloud_pct,visibility_m,uv_index,provider,fetched_at,confidence")
      .eq("geohash", geohash)
      .eq("kind", "forecast")
      .gte("valid_time", nowIso)
      .lte("valid_time", endIso)
      .order("valid_time", { ascending: true })
      .limit(200);
    if (error) throw error;

    let hourly = (rows ?? []) as WxHourlyPoint[];
    if (hourly.length === 0) {
      const chain = provider === "auto"
        ? defaultProviderPriority()
        : [provider as Exclude<WxProvider, "auto">];
      const p = chain[0];
      const r = await fetchForecastWithProvider({
        provider: p,
        lat: loc.lat,
        lon: loc.lon,
        hours: Math.max(24, windowHours),
        days: 14,
      });
      hourly = r.hourly as WxHourlyPoint[];
    }

    const { data: alerts, error: aErr } = await supabase.rpc("wx_alerts_nearby", {
      in_lat: loc.lat,
      in_lon: loc.lon,
      in_radius_m: radiusKm * 1000,
    });
    if (aErr) throw aErr;

    const reasons = computeReasons({
      windowHours,
      hourly,
      activeAlertsCount: (alerts ?? []).length,
    });
    const risk_level = riskLevelFromReasons(reasons);

    const snapshotRow = {
      geohash,
      computed_at: new Date().toISOString(),
      window_hours: windowHours,
      risk_level,
      reasons,
    };
    await supabase.from("wx_risk_snapshots").insert(snapshotRow);

    const response: WxRiskResponse = {
      meta: {
        fetched_at: new Date().toISOString(),
        lat: loc.lat,
        lon: loc.lon,
        window_hours: windowHours,
        radius_km: radiusKm,
        place_id: loc.place_id,
        country_code: loc.country_code,
        admin1: loc.admin1,
        admin2: loc.admin2,
        admin3: loc.admin3,
        admin4: loc.admin4,
        locality: loc.locality,
        name: loc.name,
      },
      risk_level,
      reasons,
    };

    return jsonResponse(response);
  } catch (e) {
    return jsonError(e);
  }
});

