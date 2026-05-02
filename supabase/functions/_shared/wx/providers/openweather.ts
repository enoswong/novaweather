// 修改說明：OpenWeather provider adapter（備援 3；MVP 使用 One Call 3.0）
// 影響文件：supabase/functions/_shared/wx/providers/openweather.ts

import type { WxDailyPoint, WxHourlyPoint } from "../types.ts";

type OpenWeatherHourly = {
  dt: number;
  temp?: number;
  feels_like?: number;
  humidity?: number;
  dew_point?: number;
  pressure?: number;
  wind_speed?: number;
  wind_deg?: number;
  wind_gust?: number;
  pop?: number;
  rain?: { "1h"?: number };
  snow?: { "1h"?: number };
  clouds?: number;
  visibility?: number;
  uvi?: number;
};

type OpenWeatherDaily = {
  dt: number;
  temp?: { min?: number; max?: number };
  pop?: number;
  rain?: number;
  snow?: number;
  wind_speed?: number;
  uvi?: number;
};

type OpenWeatherResponse = {
  timezone?: string;
  hourly?: OpenWeatherHourly[];
  daily?: OpenWeatherDaily[];
};

export async function fetchOpenWeatherForecast(params: {
  lat: number;
  lon: number;
  hours: number;
  days: number;
  apiKey: string;
}): Promise<{
  timezone: string;
  fetched_at: string;
  hourly: WxHourlyPoint[];
  daily: WxDailyPoint[];
  source_latency_ms: number | null;
}> {
  const { lat, lon, hours, days, apiKey } = params;

  const url = new URL("https://api.openweathermap.org/data/3.0/onecall");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("appid", apiKey);
  url.searchParams.set("units", "metric");
  url.searchParams.set("exclude", "minutely,alerts");

  const t0 = performance.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const latency = Math.round(performance.now() - t0);
  if (!res.ok) throw new Error(`OpenWeather HTTP ${res.status}`);
  const fetchedAt = new Date().toISOString();
  const data = (await res.json()) as OpenWeatherResponse;

  const hourly: WxHourlyPoint[] = [];
  for (const h of (data.hourly ?? []).slice(0, Math.max(0, hours))) {
    hourly.push({
      valid_time: new Date(h.dt * 1000).toISOString(),
      temp_c: h.temp ?? null,
      feels_like_c: h.feels_like ?? null,
      humidity_pct: h.humidity ?? null,
      dewpoint_c: h.dew_point ?? null,
      pressure_hpa: h.pressure ?? null,

      wind_ms: h.wind_speed ?? null,
      wind_dir_deg: h.wind_deg ?? null,
      gust_ms: h.wind_gust ?? null,

      precip_mm: h.rain?.["1h"] ?? null,
      precip_prob: h.pop ?? null,
      snow_mm: h.snow?.["1h"] ?? null,

      cloud_pct: h.clouds ?? null,
      visibility_m: h.visibility ?? null,
      uv_index: h.uvi ?? null,

      provider: "openweather",
      fetched_at: fetchedAt,
      confidence: 0.7,
    });
  }

  const daily: WxDailyPoint[] = [];
  for (const d of (data.daily ?? []).slice(0, Math.max(1, days))) {
    const date = new Date(d.dt * 1000);
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    daily.push({
      date: `${yyyy}-${mm}-${dd}`,
      t_min_c: d.temp?.min ?? null,
      t_max_c: d.temp?.max ?? null,
      precip_sum_mm: d.rain ?? null,
      precip_prob_max: d.pop ?? null,
      wind_max_ms: d.wind_speed ?? null,
      uv_max: d.uvi ?? null,
      provider: "openweather",
      fetched_at: fetchedAt,
      confidence: 0.7,
    });
  }

  return {
    timezone: data.timezone ?? "UTC",
    fetched_at: fetchedAt,
    hourly,
    daily,
    source_latency_ms: Number.isFinite(latency) ? latency : null,
  };
}

