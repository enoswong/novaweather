// 修改說明：Open‑Meteo provider adapter（主力，無需 API key）
// 影響文件：supabase/functions/_shared/wx/providers/open_meteo.ts
// UTC 策略：強制 timezone=UTC，所有時間以 UTC 為基準存入 DB

import type { WxDailyPoint, WxHourlyPoint } from "../types.ts";

type OpenMeteoHourly = {
  time: string[];
  temperature_2m?: number[];
  apparent_temperature?: number[];
  relative_humidity_2m?: number[];
  dew_point_2m?: number[];
  pressure_msl?: number[];
  precipitation?: number[];
  precipitation_probability?: number[];
  snowfall?: number[];
  cloud_cover?: number[];
  visibility?: number[];
  uv_index?: number[];
  wind_speed_10m?: number[];
  wind_direction_10m?: number[];
  wind_gusts_10m?: number[];
};

type OpenMeteoDaily = {
  time: string[];
  temperature_2m_min?: number[];
  temperature_2m_max?: number[];
  precipitation_sum?: number[];
  precipitation_probability_max?: number[];
  wind_speed_10m_max?: number[];
  uv_index_max?: number[];
};

type OpenMeteoForecastResponse = {
  timezone: string;
  hourly?: OpenMeteoHourly;
  daily?: OpenMeteoDaily;
};

const HOURLY_FIELDS = [
  "temperature_2m",
  "apparent_temperature",
  "relative_humidity_2m",
  "dew_point_2m",
  "pressure_msl",
  "precipitation",
  "precipitation_probability",
  "snowfall",
  "cloud_cover",
  "visibility",
  "uv_index",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
].join(",");

const DAILY_FIELDS = [
  "temperature_2m_min",
  "temperature_2m_max",
  "precipitation_sum",
  "precipitation_probability_max",
  "wind_speed_10m_max",
  "uv_index_max",
].join(",");

export async function fetchOpenMeteoForecast(params: {
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
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("hourly", HOURLY_FIELDS);
  url.searchParams.set("daily", DAILY_FIELDS);
  url.searchParams.set("forecast_hours", String(hours));
  url.searchParams.set("forecast_days", String(days));
  // 強制 UTC：Open-Meteo 以 timezone=auto 回傳本地時間字串（無 offset），
  // 在 Deno UTC 伺服器上 new Date("2026-05-03T09:00") 被誤認為 UTC 09:00，
  // 但對 UTC+9 的東京而言實際是 UTC 00:00 → 9 小時偏差。
  // 改為 timezone=UTC 後，回傳值即代表 UTC 時間，附加 "Z" 確保明確解析。
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("temperature_unit", "celsius");
  url.searchParams.set("wind_speed_unit", "ms");
  url.searchParams.set("precipitation_unit", "mm");

  const t0 = performance.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const latency = Math.round(performance.now() - t0);
  if (!res.ok) {
    throw new Error(`Open-Meteo HTTP ${res.status}`);
  }
  const fetchedAt = new Date().toISOString();
  const data = (await res.json()) as OpenMeteoForecastResponse;

  const hourly: WxHourlyPoint[] = [];
  const h = data.hourly;
  if (h?.time?.length) {
    for (let i = 0; i < h.time.length; i++) {
      hourly.push({
        // Open-Meteo with timezone=UTC returns "2026-05-03T09:00" (no seconds, no Z).
        // Appending "Z" forces explicit UTC interpretation regardless of server locale.
        valid_time: new Date(h.time[i] + "Z").toISOString(),

        temp_c: h.temperature_2m?.[i] ?? null,
        feels_like_c: h.apparent_temperature?.[i] ?? null,
        humidity_pct: h.relative_humidity_2m?.[i] ?? null,
        dewpoint_c: h.dew_point_2m?.[i] ?? null,
        pressure_hpa: h.pressure_msl?.[i] ?? null,

        wind_ms: h.wind_speed_10m?.[i] ?? null,
        wind_dir_deg: h.wind_direction_10m?.[i] ?? null,
        gust_ms: h.wind_gusts_10m?.[i] ?? null,

        precip_mm: h.precipitation?.[i] ?? null,
        precip_prob: h.precipitation_probability?.[i] == null
          ? null
          : h.precipitation_probability[i] / 100,
        snow_mm: h.snowfall?.[i] ?? null,

        cloud_pct: h.cloud_cover?.[i] ?? null,
        visibility_m: h.visibility?.[i] ?? null,
        uv_index: h.uv_index?.[i] ?? null,

        provider: "open_meteo",
        fetched_at: fetchedAt,
        confidence: 0.8,
      });
    }
  }

  const daily: WxDailyPoint[] = [];
  const d = data.daily;
  if (d?.time?.length) {
    for (let i = 0; i < d.time.length; i++) {
      daily.push({
        // timezone=UTC → d.time[i] is already a UTC date string ("YYYY-MM-DD")
        date: d.time[i],
        t_min_c: d.temperature_2m_min?.[i] ?? null,
        t_max_c: d.temperature_2m_max?.[i] ?? null,
        precip_sum_mm: d.precipitation_sum?.[i] ?? null,
        precip_prob_max: d.precipitation_probability_max?.[i] == null
          ? null
          : d.precipitation_probability_max[i] / 100,
        wind_max_ms: d.wind_speed_10m_max?.[i] ?? null,
        uv_max: d.uv_index_max?.[i] ?? null,
        provider: "open_meteo",
        fetched_at: fetchedAt,
        confidence: 0.8,
      });
    }
  }

  return {
    timezone: data.timezone ?? "UTC",
    fetched_at: fetchedAt,
    hourly,
    daily,
    source_latency_ms: Number.isFinite(latency) ? latency : null,
  };
}

