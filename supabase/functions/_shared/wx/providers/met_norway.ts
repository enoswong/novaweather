// Met Norway (Yr.no) provider adapter
// Endpoint: https://api.met.no/weatherapi/locationforecast/2.0/compact
// 特性：ECMWF 模型，歐洲精度最高，全球可用，完全免費（Attribution 要求）
// 時間：所有時間戳為 UTC ISO 8601（已含 Z），無需額外處理
// 影響文件：supabase/functions/_shared/wx/providers/met_norway.ts

import type { WxDailyPoint, WxHourlyPoint } from "../types.ts";

// Met Norway Compact API 回應型別（部分欄位）
type MetNorwayTimestep = {
  time: string; // ISO 8601 UTC, e.g. "2026-05-03T12:00:00Z"
  data: {
    instant: {
      details: {
        air_pressure_at_sea_level?: number;   // hPa
        air_temperature?: number;             // °C
        cloud_area_fraction?: number;         // %
        dew_point_temperature?: number;       // °C
        relative_humidity?: number;           // %
        wind_from_direction?: number;         // degrees
        wind_speed?: number;                  // m/s
        wind_speed_of_gust?: number;          // m/s
        fog_area_fraction?: number;           // %
        ultraviolet_index_clear_sky?: number;
      };
    };
    next_1_hours?: {
      summary: { symbol_code: string };
      details: {
        precipitation_amount?: number;        // mm
        precipitation_probability?: number;   // %
        precipitation_amount_min?: number;    // mm
        precipitation_amount_max?: number;    // mm
        ultraviolet_index_clear_sky_max?: number;
      };
    };
    next_6_hours?: {
      summary: { symbol_code: string };
      details: {
        precipitation_amount?: number;        // mm
        precipitation_probability?: number;   // %
        air_temperature_min?: number;
        air_temperature_max?: number;
      };
    };
    next_12_hours?: {
      summary: { symbol_code: string };
      details: {
        precipitation_probability?: number; // %
      };
    };
  };
};

type MetNorwayResponse = {
  type: string;
  properties: {
    meta: { updated_at: string; units: Record<string, string> };
    timeseries: MetNorwayTimestep[];
  };
};

// Met Norway Attribution 要求：User-Agent 必須包含專案名稱及聯絡資訊
const USER_AGENT = "NovaWeather/1.0 (novaweather@example.com)";

export async function fetchMetNorwayForecast(params: {
  lat: number;
  lon: number;
  hours: number;
  days: number;
}): Promise<{
  timezone: string;
  fetched_at: string;
  hourly: WxHourlyPoint[];
  daily: WxDailyPoint[];
  source_latency_ms: number | null;
}> {
  const { lat, lon, hours, days } = params;

  const url = new URL(
    "https://api.met.no/weatherapi/locationforecast/2.0/compact",
  );
  url.searchParams.set("lat", lat.toFixed(4));
  url.searchParams.set("lon", lon.toFixed(4));

  const t0 = performance.now();
  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(12000),
  });
  const latency = Math.round(performance.now() - t0);

  if (!res.ok) {
    throw new Error(`Met Norway HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const fetchedAt = new Date().toISOString();
  const data = (await res.json()) as MetNorwayResponse;
  const timeseries = data.properties.timeseries ?? [];

  // ── Hourly series ─────────────────────────────────────────────────────────
  const cutoffHourly = new Date(Date.now() + hours * 3600 * 1000);
  const hourly: WxHourlyPoint[] = [];

  for (const ts of timeseries) {
    const t = new Date(ts.time);
    if (t > cutoffHourly) break;

    const instant = ts.data.instant.details;
    const next1h = ts.data.next_1_hours?.details;

    const precipProb = next1h?.precipitation_probability != null
      ? next1h.precipitation_probability / 100
      : null;

    hourly.push({
      valid_time: ts.time, // already UTC ISO 8601 with Z
      temp_c: instant.air_temperature ?? null,
      feels_like_c: null, // Met Norway compact does not provide feels-like
      humidity_pct: instant.relative_humidity ?? null,
      dewpoint_c: instant.dew_point_temperature ?? null,
      pressure_hpa: instant.air_pressure_at_sea_level ?? null,
      wind_ms: instant.wind_speed ?? null,
      wind_dir_deg: instant.wind_from_direction ?? null,
      gust_ms: instant.wind_speed_of_gust ?? null,
      precip_mm: next1h?.precipitation_amount ?? null,
      precip_prob: precipProb,
      snow_mm: null, // not directly available in compact format
      cloud_pct: instant.cloud_area_fraction ?? null,
      visibility_m: null, // not in compact
      uv_index: instant.ultraviolet_index_clear_sky
        ?? next1h?.ultraviolet_index_clear_sky_max
        ?? null,
      provider: "met_norway",
      fetched_at: fetchedAt,
      confidence: 0.85, // ECMWF 模型，略高於 Open-Meteo 的 GFS/ICON 混合
    });
  }

  // ── Daily series (aggregated from 6-hour blocks) ──────────────────────────
  // Met Norway 無直接 daily summary，從 next_6_hours 欄位聚合
  // 策略：每天（UTC midnight 開始）掃描所有 timestep，收集 6h 區塊，合成 daily point
  const dailyMap = new Map<
    string, // "YYYY-MM-DD"
    {
      temps: number[];
      t_min: number | null;
      t_max: number | null;
      precip_sum: number;
      precip_probs: number[];
      winds: number[];
      uv_vals: number[];
    }
  >();

  const cutoffDaily = new Date(Date.now() + days * 86400 * 1000);

  for (const ts of timeseries) {
    const t = new Date(ts.time);
    if (t > cutoffDaily) break;

    const dateStr = ts.time.slice(0, 10); // "YYYY-MM-DD"
    if (!dailyMap.has(dateStr)) {
      dailyMap.set(dateStr, {
        temps: [],
        t_min: null,
        t_max: null,
        precip_sum: 0,
        precip_probs: [],
        winds: [],
        uv_vals: [],
      });
    }

    const entry = dailyMap.get(dateStr)!;
    const instant = ts.data.instant.details;
    const next6h = ts.data.next_6_hours?.details;

    if (instant.air_temperature != null) {
      entry.temps.push(instant.air_temperature);
      if (next6h?.air_temperature_min != null) {
        entry.t_min = entry.t_min == null
          ? next6h.air_temperature_min
          : Math.min(entry.t_min, next6h.air_temperature_min);
      }
      if (next6h?.air_temperature_max != null) {
        entry.t_max = entry.t_max == null
          ? next6h.air_temperature_max
          : Math.max(entry.t_max, next6h.air_temperature_max);
      }
    }
    if (next6h?.precipitation_amount != null) {
      entry.precip_sum += next6h.precipitation_amount;
    }
    if (next6h?.precipitation_probability != null) {
      entry.precip_probs.push(next6h.precipitation_probability);
    }
    if (instant.wind_speed != null) {
      entry.winds.push(instant.wind_speed);
    }
    const uv = instant.ultraviolet_index_clear_sky ?? null;
    if (uv != null) entry.uv_vals.push(uv);
  }

  const daily: WxDailyPoint[] = [];
  const sortedDates = [...dailyMap.keys()].sort();

  for (const dateStr of sortedDates.slice(0, days)) {
    const e = dailyMap.get(dateStr)!;

    const t_min = e.t_min ?? (e.temps.length > 0 ? Math.min(...e.temps) : null);
    const t_max = e.t_max ?? (e.temps.length > 0 ? Math.max(...e.temps) : null);
    const precip_prob_max = e.precip_probs.length > 0
      ? Math.max(...e.precip_probs) / 100
      : null;
    const wind_max_ms = e.winds.length > 0 ? Math.max(...e.winds) : null;
    const uv_max = e.uv_vals.length > 0 ? Math.max(...e.uv_vals) : null;

    daily.push({
      date: dateStr, // UTC date
      t_min_c: t_min,
      t_max_c: t_max,
      precip_sum_mm: e.precip_sum > 0 ? Number(e.precip_sum.toFixed(2)) : 0,
      precip_prob_max,
      wind_max_ms,
      uv_max,
      provider: "met_norway",
      fetched_at: fetchedAt,
      confidence: 0.85,
    });
  }

  return {
    timezone: "UTC",
    fetched_at: fetchedAt,
    hourly,
    daily,
    source_latency_ms: Number.isFinite(latency) ? latency : null,
  };
}
