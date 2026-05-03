// 修改說明：WeatherAPI.com provider adapter（備援 1）
// 影響文件：supabase/functions/_shared/wx/providers/weatherapi.ts
// UTC 策略：使用 time_epoch（Unix 秒）轉 UTC；WeatherAPI 每小時必定回傳此欄位

import type { WxDailyPoint, WxHourlyPoint } from "../types.ts";

type WeatherApiForecastHour = {
  time: string;       // local time "2026-05-03 09:00" — do NOT use for UTC conversion
  time_epoch?: number; // Unix seconds UTC — preferred for valid_time
  temp_c?: number;
  feelslike_c?: number;
  humidity?: number;
  dewpoint_c?: number;
  pressure_mb?: number;
  wind_kph?: number;
  wind_degree?: number;
  gust_kph?: number;
  precip_mm?: number;
  chance_of_rain?: number;
  chance_of_snow?: number;
  cloud?: number;
  vis_km?: number;
  uv?: number;
};

type WeatherApiForecastDay = {
  date: string;
  day?: {
    mintemp_c?: number;
    maxtemp_c?: number;
    totalprecip_mm?: number;
    daily_chance_of_rain?: number;
    maxwind_kph?: number;
    uv?: number;
  };
  hour?: WeatherApiForecastHour[];
};

type WeatherApiResponse = {
  location?: { tz_id?: string };
  forecast?: { forecastday?: WeatherApiForecastDay[] };
};

function kphToMs(kph: number | undefined): number | null {
  if (kph == null) return null;
  return (kph * 1000) / 3600;
}

export async function fetchWeatherApiForecast(params: {
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
  const url = new URL("https://api.weatherapi.com/v1/forecast.json");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("q", `${lat},${lon}`);
  url.searchParams.set("days", String(Math.max(1, Math.min(10, days))));
  url.searchParams.set("aqi", "no");
  url.searchParams.set("alerts", "no");

  const t0 = performance.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const latency = Math.round(performance.now() - t0);
  if (!res.ok) throw new Error(`WeatherAPI HTTP ${res.status}`);
  const fetchedAt = new Date().toISOString();
  const data = (await res.json()) as WeatherApiResponse;

  const timezone = data.location?.tz_id ?? "UTC";
  const hourly: WxHourlyPoint[] = [];
  const daily: WxDailyPoint[] = [];

  const daysArr = data.forecast?.forecastday ?? [];
  for (const day of daysArr) {
    daily.push({
      date: day.date,
      t_min_c: day.day?.mintemp_c ?? null,
      t_max_c: day.day?.maxtemp_c ?? null,
      precip_sum_mm: day.day?.totalprecip_mm ?? null,
      precip_prob_max: day.day?.daily_chance_of_rain == null
        ? null
        : day.day.daily_chance_of_rain / 100,
      wind_max_ms: kphToMs(day.day?.maxwind_kph) ?? null,
      uv_max: day.day?.uv ?? null,
      provider: "weatherapi",
      fetched_at: fetchedAt,
      confidence: 0.75,
    });

    for (const h of day.hour ?? []) {
      hourly.push({
        // WeatherAPI returns local time strings ("2026-05-03 09:00", no UTC offset).
        // new Date("2026-05-03 09:00") is non-standard and parses as local time,
        // which is UTC on Deno servers but wrong for non-UTC locations.
        // Use time_epoch (Unix seconds) instead — always UTC-correct.
        valid_time: h.time_epoch != null
          ? new Date(h.time_epoch * 1000).toISOString()
          : new Date(h.time.replace(" ", "T") + "Z").toISOString(), // last-resort fallback
        temp_c: h.temp_c ?? null,
        feels_like_c: h.feelslike_c ?? null,
        humidity_pct: h.humidity ?? null,
        dewpoint_c: h.dewpoint_c ?? null,
        pressure_hpa: h.pressure_mb ?? null,

        wind_ms: kphToMs(h.wind_kph),
        wind_dir_deg: h.wind_degree ?? null,
        gust_ms: kphToMs(h.gust_kph),

        precip_mm: h.precip_mm ?? null,
        precip_prob: h.chance_of_rain == null ? null : h.chance_of_rain / 100,
        snow_mm: null,

        cloud_pct: h.cloud ?? null,
        visibility_m: h.vis_km == null ? null : h.vis_km * 1000,
        uv_index: h.uv ?? null,

        provider: "weatherapi",
        fetched_at: fetchedAt,
        confidence: 0.75,
      });
    }
  }

  // 截斷到要求的 hours（WeatherAPI 回的是跨多日每小時）
  hourly.sort((a, b) => a.valid_time.localeCompare(b.valid_time));
  const hourlyTrimmed = hourly.slice(0, Math.max(0, hours));

  return {
    timezone,
    fetched_at: fetchedAt,
    hourly: hourlyTrimmed,
    daily,
    source_latency_ms: Number.isFinite(latency) ? latency : null,
  };
}

