// 修改說明：新增 /wx/environment/timeline（分/時/日與未來數天環境變化與極端風險）
// 影響文件：supabase/functions/wx-environment-timeline/index.ts
// v1.0.0: 整合 Open-Meteo minutely_15 臨近預報（nowcasting），
//         取代原有線性插值作為 minute 序列資料源（降級至線性插值）

import { jsonError, jsonResponse } from "../_shared/wx/http.ts";
import { fetchForecastWithProvider, geoRoutedPriority } from "../_shared/wx/provider_chain.ts";
import { fetchOpenMeteoNowcast } from "../_shared/wx/providers/open_meteo.ts";
import { buildCacheKey, tryReadCache, writeCache } from "../_shared/wx/storage.ts";
import { getSupabaseAdminClient } from "../_shared/wx/supabase.ts";
import { resolveLocationFromRequest } from "../_shared/wx/location.ts";
import type {
  WxDailyPoint,
  WxEnvironmentDailyPoint,
  WxEnvironmentHourlyPoint,
  WxEnvironmentMinutePoint,
  WxEnvironmentTimelineResponse,
  WxHourlyPoint,
  WxNowcastPoint,
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

/**
 * 建立分鐘級序列。
 *
 * 優先使用 Open-Meteo minutely_15 真實資料（15 分鐘粒度），
 * 在 15 分鐘點之間線性插值至 1 分鐘解析度。
 * temp_c / humidity_pct 不在 nowcast 中，從 observed → hourly[0] 線性插值。
 *
 * 若 nowcast 無資料（空陣列或 fetch 失敗），降回全量線性插值（原有行為）。
 */
function buildMinuteSeries(args: {
  minuteWindow: number;
  observed: WxHourlyPoint | null;
  hourly: WxHourlyPoint[];
  activeAlertsCount: number;
  nowcastPoints: WxNowcastPoint[];
}): WxEnvironmentMinutePoint[] {
  const { minuteWindow, observed, hourly, activeAlertsCount, nowcastPoints } = args;
  const now = Date.now();
  const first = hourly[0] ?? null;
  const start = observed ?? first;
  if (!start && nowcastPoints.length === 0) return [];

  // ── 基礎溫度/濕度（從 observed → hourly[0] 插值，nowcast 不含這兩個欄位）
  const startTemp = safeNum(start?.temp_c);
  const endTemp = safeNum(first?.temp_c);
  const startHum = safeNum(start?.humidity_pct);
  const endHum = safeNum(first?.humidity_pct);

  const points: WxEnvironmentMinutePoint[] = [];

  if (nowcastPoints.length >= 2) {
    // ── Nowcast 路徑：使用真實 minutely_15 資料，插值至 1 分鐘解析度
    const cutoffMs = now + minuteWindow * 60 * 1000;

    // 只保留未來 minuteWindow 分鐘內的點
    const relevant = nowcastPoints.filter(
      (p) => new Date(p.valid_time).getTime() <= cutoffMs,
    );
    if (relevant.length === 0) {
      // nowcast 資料點全在窗口外（不應發生），降回線性插值
      return buildMinuteLinearFallback(
        { minuteWindow, startTemp, endTemp, startHum, endHum, start, first, activeAlertsCount, now },
      );
    }

    for (let m = 1; m <= minuteWindow; m++) {
      const targetMs = now + m * 60 * 1000;
      if (targetMs > cutoffMs) break;

      // 找到包圍 targetMs 的兩個 nowcast 點，線性插值
      let p0 = relevant[0];
      let p1 = relevant[relevant.length - 1];
      for (let i = 0; i < relevant.length - 1; i++) {
        const t0 = new Date(relevant[i].valid_time).getTime();
        const t1 = new Date(relevant[i + 1].valid_time).getTime();
        if (targetMs >= t0 && targetMs <= t1) {
          p0 = relevant[i];
          p1 = relevant[i + 1];
          break;
        }
      }
      const t0Ms = new Date(p0.valid_time).getTime();
      const t1Ms = new Date(p1.valid_time).getTime();
      const alpha = t1Ms > t0Ms ? (targetMs - t0Ms) / (t1Ms - t0Ms) : 0;

      const precip_prob = lerp(p0.precip_prob, p1.precip_prob, alpha);
      const wind_ms = lerp(p0.wind_ms, p1.wind_ms, alpha);
      const gust_ms = lerp(p0.gust_ms, p1.gust_ms, alpha);
      // precip_mm_h → 近似為 mm/h（用作 risk 判斷的 precip_mm 替代）
      const precip_mm_h = lerp(p0.precip_mm_h, p1.precip_mm_h, alpha);

      // temp / humidity 仍用全局線性插值
      const tGlobal = m / minuteWindow;
      const temp_c = lerp(startTemp, endTemp, tGlobal);
      const humidity_pct = lerp(startHum, endHum, tGlobal);

      const risk = riskFromAtmosphere({
        temp_c,
        humidity_pct,
        precip_prob,
        precip_mm: precip_mm_h, // mm/h ≈ mm within 1-minute window
        wind_ms,
        gust_ms,
        activeAlertsCount,
      });

      points.push({
        valid_time: new Date(targetMs).toISOString(),
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

  // ── 降級：全量線性插值（原有行為）
  return buildMinuteLinearFallback(
    { minuteWindow, startTemp, endTemp, startHum, endHum, start, first, activeAlertsCount, now },
  );
}

function buildMinuteLinearFallback(args: {
  minuteWindow: number;
  startTemp: number | null;
  endTemp: number | null;
  startHum: number | null;
  endHum: number | null;
  start: WxHourlyPoint | null;
  first: WxHourlyPoint | null;
  activeAlertsCount: number;
  now: number;
}): WxEnvironmentMinutePoint[] {
  const { minuteWindow, startTemp, endTemp, startHum, endHum, start, first, activeAlertsCount, now } = args;
  const startProb = safeNum(start?.precip_prob);
  const endProb = safeNum(first?.precip_prob);
  const startWind = safeNum(start?.wind_ms);
  const endWind = safeNum(first?.wind_ms);
  const startGust = safeNum(start?.gust_ms);
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

    // ── 並行：DB 查詢 + nowcast（nowcast TTL=5min 快取）──────────────────────
    const nowcastCacheKey = buildCacheKey({
      geohash,
      endpoint: "minutely_15_nowcast",
      params: { minute_window: minuteWindow },
    });

    const [
      { data: hourlyRows, error: hourlyErr },
      { data: dailyRows, error: dailyErr },
      { data: observedRows, error: observedErr },
      nowcastCached,
    ] = await Promise.all([
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
      tryReadCache(supabase, nowcastCacheKey),
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
      const chain = provider === "auto" ? geoRoutedPriority(loc.country_code) : [provider as Exclude<WxProvider, "auto" | "nova_ensemble">];
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

    // ── Nowcasting（minutely_15）───────────────────────────────────────────
    // 優先從快取取得；未命中則 live fetch Open-Meteo，成功後寫入快取（TTL 5 分鐘）
    let nowcastPoints: WxNowcastPoint[] = [];

    if (nowcastCached?.isFresh) {
      nowcastPoints = (nowcastCached.payload as WxNowcastPoint[]) ?? [];
    } else {
      try {
        const nc = await fetchOpenMeteoNowcast({ lat: loc.lat, lon: loc.lon, minuteWindow });
        nowcastPoints = nc.points;
        if (nowcastPoints.length > 0) {
          await writeCache(supabase, {
            cache_key: nowcastCacheKey,
            geohash,
            endpoint: "minutely_15_nowcast",
            params: { minute_window: minuteWindow },
            payload: nowcastPoints,
            ttlSeconds: 5 * 60, // 5 分鐘短效快取
            fetched_at: nc.fetched_at,
          });
        }
      } catch (e) {
        // nowcast fetch 失敗 → 靜默降級至線性插值，不影響主流程
        console.warn("Nowcast fetch failed, using linear interpolation:", e instanceof Error ? e.message : String(e));
      }
    }

    const minute = buildMinuteSeries({
      minuteWindow,
      observed,
      hourly,
      activeAlertsCount,
      nowcastPoints,
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
