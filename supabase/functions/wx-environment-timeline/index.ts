// 修改說明：新增 /wx/environment/timeline（分/時/日與未來數天環境變化與極端風險）
// 影響文件：supabase/functions/wx-environment-timeline/index.ts

import { jsonError, jsonResponse } from "../_shared/wx/http.ts";
import { fetchForecastWithProvider, defaultProviderPriority } from "../_shared/wx/provider_chain.ts";
import { getSupabaseAdminClient } from "../_shared/wx/supabase.ts";
import { resolveLocationFromRequest } from "../_shared/wx/location.ts";
import type {
  WxDailyPoint,
  WxEnvironmentDailyPoint,
  WxEnvironmentHourlyPoint,
  WxEnvironmentMinutePoint,
  WxEnvironmentTimelineResponse,
  WxHourlyPoint,
  WxProvider,
  WxRiskReason,
} from "../_shared/wx/types.ts";
import { clampInt } from "../_shared/wx/validate.ts";

function safeNum(v: unknown): number | null {
  if (typeof v !== "number") return null;
  if (!Number.isFinite(v)) return null;
  return v;
}

function lerp(a: number | null, b: number | null, t: number): number | null {
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  return a + (b - a) * t;
}

function riskFromAtmosphere(args: {
  temp_c: number | null;
  humidity_pct: number | null;
  precip_prob: number | null;
  precip_mm: number | null;
  wind_ms: number | null;
  gust_ms: number | null;
  activeAlertsCount: number;
}): { risk_level: 0 | 1 | 2 | 3; reasons: WxRiskReason[]; tags: string[] } {
  const { temp_c, humidity_pct, precip_prob, precip_mm, wind_ms, gust_ms, activeAlertsCount } = args;
  const reasons: WxRiskReason[] = [];
  const tags: string[] = [];
  let risk: 0 | 1 | 2 | 3 = 0;

  function pushReason(reason: WxRiskReason) {
    reasons.push(reason);
    risk = Math.max(risk, reason.severity) as 0 | 1 | 2 | 3;
  }

  if (temp_c != null && temp_c >= 35) {
    pushReason({
      code: "heat_extreme",
      severity: temp_c >= 40 ? 3 : 2,
      details: { temp_c },
    });
    tags.push("hot");
  }

  if (temp_c != null && temp_c <= 0) {
    pushReason({
      code: "cold_extreme",
      severity: temp_c <= -5 ? 2 : 1,
      details: { temp_c },
    });
    tags.push("cold");
  }

  if (humidity_pct != null && humidity_pct <= 35) {
    pushReason({
      code: "dry_air",
      severity: humidity_pct <= 20 ? 2 : 1,
      details: { humidity_pct },
    });
    tags.push("dry");
  }

  if (humidity_pct != null && humidity_pct >= 90) {
    pushReason({
      code: "humidity_gt_90",
      severity: 1,
      details: { humidity_pct },
    });
    tags.push("humid");
  }

  const rainSev = (precip_prob != null && precip_prob >= 0.85) || (precip_mm != null && precip_mm >= 30)
    ? 2
    : (precip_prob != null && precip_prob >= 0.6) || (precip_mm != null && precip_mm >= 10)
    ? 1
    : 0;
  if (rainSev > 0) {
    pushReason({
      code: "heavy_rain_prob",
      severity: rainSev as 1 | 2,
      details: { precip_prob, precip_mm },
    });
    tags.push("rain");
  }

  const windSev = (gust_ms != null && gust_ms >= 30) || (wind_ms != null && wind_ms >= 20)
    ? 2
    : (gust_ms != null && gust_ms >= 20) || (wind_ms != null && wind_ms >= 13.9)
    ? 1
    : 0;
  if (windSev > 0) {
    pushReason({
      code: "strong_wind",
      severity: windSev as 1 | 2,
      details: { wind_ms, gust_ms },
    });
    tags.push("windy");
  }

  if ((rainSev >= 1 && windSev >= 1) || (gust_ms != null && gust_ms >= 24 && precip_prob != null && precip_prob >= 0.65)) {
    pushReason({
      code: "storm_condition",
      severity: rainSev >= 2 || windSev >= 2 ? 3 : 2,
      details: { precip_prob, precip_mm, wind_ms, gust_ms },
    });
    tags.push("storm");
  }

  if (activeAlertsCount > 0) {
    pushReason({
      code: "official_alert",
      severity: 2,
      details: { active_alerts: activeAlertsCount },
    });
    tags.push("official-alert");
  }

  if (tags.length === 0) tags.push("stable");
  return { risk_level: risk, reasons, tags };
}

function buildMinuteSeries(args: {
  minuteWindow: number;
  observed: WxHourlyPoint | null;
  hourly: WxHourlyPoint[];
  activeAlertsCount: number;
}): WxEnvironmentMinutePoint[] {
  const { minuteWindow, observed, hourly, activeAlertsCount } = args;
  const now = Date.now();
  const first = hourly[0] ?? null;
  const start = observed ?? first;
  if (!start) return [];

  const startTemp = safeNum(start.temp_c);
  const endTemp = safeNum(first?.temp_c);
  const startHum = safeNum(start.humidity_pct);
  const endHum = safeNum(first?.humidity_pct);
  const startProb = safeNum(start.precip_prob);
  const endProb = safeNum(first?.precip_prob);
  const startWind = safeNum(start.wind_ms);
  const endWind = safeNum(first?.wind_ms);
  const startGust = safeNum(start.gust_ms);
  const endGust = safeNum(first?.gust_ms);

  const points: WxEnvironmentMinutePoint[] = [];
  for (let i = 1; i <= minuteWindow; i++) {
    const t = i / minuteWindow;
    const temp_c = lerp(startTemp, endTemp, t);
    const humidity_pct = lerp(startHum, endHum, t);
    const precip_prob = lerp(startProb, endProb, t);
    const wind_ms = lerp(startWind, endWind, t);
    const gust_ms = lerp(startGust, endGust, t);
    const risk = riskFromAtmosphere({
      temp_c,
      humidity_pct,
      precip_prob,
      precip_mm: null,
      wind_ms,
      gust_ms,
      activeAlertsCount,
    });

    points.push({
      valid_time: new Date(now + i * 60 * 1000).toISOString(),
      temp_c: temp_c == null ? null : Number(temp_c.toFixed(2)),
      humidity_pct: humidity_pct == null ? null : Number(humidity_pct.toFixed(1)),
      precip_prob: precip_prob == null ? null : Number(precip_prob.toFixed(3)),
      wind_ms: wind_ms == null ? null : Number(wind_ms.toFixed(2)),
      gust_ms: gust_ms == null ? null : Number(gust_ms.toFixed(2)),
      risk,
    });
  }
  return points;
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

    const url = new URL(req.url);
    const supabase = getSupabaseAdminClient();
    const loc = await resolveLocationFromRequest({ url, supabase, geohashPrecision: 6 });
    const geohash = loc.geohash;

    const windowHours = clampInt(Number(url.searchParams.get("window_hours") ?? 72), 1, 168, "window_hours");
    const days = clampInt(Number(url.searchParams.get("days") ?? 7), 1, 16, "days");
    const minuteWindow = clampInt(Number(url.searchParams.get("minute_window") ?? 60), 5, 180, "minute_window");
    const radiusKm = clampInt(Number(url.searchParams.get("radius_km") ?? 50), 1, 500, "radius_km");
    const provider = (url.searchParams.get("provider") ?? "auto") as WxProvider;
    const allowLiveFetch = url.searchParams.get("allow_live_fetch") !== "false";

    const nowIso = new Date().toISOString();
    const endIso = new Date(Date.now() + windowHours * 3600 * 1000).toISOString();
    const today = new Date();
    const todayDate = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${
      String(today.getUTCDate()).padStart(2, "0")
    }`;

    const [{ data: hourlyRows, error: hourlyErr }, { data: dailyRows, error: dailyErr }, { data: observedRows, error: observedErr }] = await Promise
      .all([
        supabase
          .from("wx_hourly_series")
          .select("valid_time,temp_c,feels_like_c,humidity_pct,dewpoint_c,pressure_hpa,wind_ms,wind_dir_deg,gust_ms,precip_mm,precip_prob,snow_mm,cloud_pct,visibility_m,uv_index,provider,fetched_at,confidence")
          .eq("geohash", geohash)
          .eq("kind", "forecast")
          .gte("valid_time", nowIso)
          .lte("valid_time", endIso)
          .order("valid_time", { ascending: true })
          .limit(windowHours),
        supabase
          .from("wx_daily_series")
          .select("date,t_min_c,t_max_c,precip_sum_mm,precip_prob_max,wind_max_ms,uv_max,provider,fetched_at,confidence")
          .eq("geohash", geohash)
          .gte("date", todayDate)
          .order("date", { ascending: true })
          .limit(days),
        supabase
          .from("wx_hourly_series")
          .select("valid_time,temp_c,feels_like_c,humidity_pct,dewpoint_c,pressure_hpa,wind_ms,wind_dir_deg,gust_ms,precip_mm,precip_prob,snow_mm,cloud_pct,visibility_m,uv_index,provider,fetched_at,confidence")
          .eq("geohash", geohash)
          .eq("kind", "observed")
          .order("valid_time", { ascending: false })
          .limit(1),
      ]);

    if (hourlyErr) throw hourlyErr;
    if (dailyErr) throw dailyErr;
    if (observedErr) throw observedErr;

    let hourly = (hourlyRows ?? []) as WxHourlyPoint[];
    let daily = (dailyRows ?? []) as WxDailyPoint[];
    let observed = ((observedRows ?? [])[0] as WxHourlyPoint | undefined) ?? null;
    let effectiveProvider = (hourly[0]?.provider ?? daily[0]?.provider ?? observed?.provider ?? "open_meteo") as Exclude<
      WxProvider,
      "auto"
    >;

    if ((hourly.length === 0 || daily.length === 0) && allowLiveFetch) {
      const chain = provider === "auto" ? defaultProviderPriority() : [provider as Exclude<WxProvider, "auto">];
      for (const p of chain) {
        try {
          const r = await fetchForecastWithProvider({
            provider: p,
            lat: loc.lat,
            lon: loc.lon,
            hours: Math.max(windowHours, 72),
            days,
          });
          if (hourly.length === 0) hourly = r.hourly.slice(0, windowHours);
          if (daily.length === 0) daily = r.daily.slice(0, days);
          if (!observed && r.hourly.length > 0) observed = r.hourly[0];
          effectiveProvider = p;
          break;
        } catch {
          // 持續嘗試下一個 provider
        }
      }
    }

    const { data: alerts, error: alertsErr } = await supabase.rpc("wx_alerts_nearby", {
      in_lat: loc.lat,
      in_lon: loc.lon,
      in_radius_m: radiusKm * 1000,
    });
    if (alertsErr) throw alertsErr;
    const activeAlertsCount = (alerts ?? []).length;

    const minute = buildMinuteSeries({
      minuteWindow,
      observed,
      hourly,
      activeAlertsCount,
    });

    const hourlyTimeline: WxEnvironmentHourlyPoint[] = hourly.map((h) => ({
      ...h,
      risk: riskFromAtmosphere({
        temp_c: safeNum(h.temp_c),
        humidity_pct: safeNum(h.humidity_pct),
        precip_prob: safeNum(h.precip_prob),
        precip_mm: safeNum(h.precip_mm),
        wind_ms: safeNum(h.wind_ms),
        gust_ms: safeNum(h.gust_ms),
        activeAlertsCount,
      }),
    }));

    const dailyTimeline: WxEnvironmentDailyPoint[] = daily.map((d) => ({
      ...d,
      risk: riskFromAtmosphere({
        temp_c: d.t_max_c != null ? Number(((d.t_max_c + (d.t_min_c ?? d.t_max_c)) / 2).toFixed(2)) : null,
        humidity_pct: null,
        precip_prob: safeNum(d.precip_prob_max),
        precip_mm: safeNum(d.precip_sum_mm),
        wind_ms: safeNum(d.wind_max_ms),
        gust_ms: null,
        activeAlertsCount,
      }),
    }));

    const nowRisk = observed
      ? riskFromAtmosphere({
        temp_c: safeNum(observed.temp_c),
        humidity_pct: safeNum(observed.humidity_pct),
        precip_prob: safeNum(observed.precip_prob),
        precip_mm: safeNum(observed.precip_mm),
        wind_ms: safeNum(observed.wind_ms),
        gust_ms: safeNum(observed.gust_ms),
        activeAlertsCount,
      })
      : null;

    const response: WxEnvironmentTimelineResponse = {
      meta: {
        fetched_at: new Date().toISOString(),
        provider: effectiveProvider,
        timezone: loc.timezone,
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
        window_hours: windowHours,
        days,
        minute_window: minuteWindow,
        radius_km: radiusKm,
      },
      alerts_summary: {
        active_count: activeAlertsCount,
      },
      now: {
        observed,
        risk: nowRisk,
      },
      minute,
      hourly: hourlyTimeline,
      daily: dailyTimeline,
    };

    return jsonResponse(response);
  } catch (e) {
    return jsonError(e);
  }
});
