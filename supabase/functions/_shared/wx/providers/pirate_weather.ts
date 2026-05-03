// Pirate Weather provider adapter
// Endpoint: https://api.pirateweather.net/forecast/{key}/{lat},{lon}?units=si
// 特性：Dark Sky 算法，北美降雨最準；SI 單位；Unix 時間戳（UTC 正確）
// 額度：20,000 次/月（免費方案）
// 影響文件：supabase/functions/_shared/wx/providers/pirate_weather.ts

import type { WxDailyPoint, WxHourlyPoint } from "../types.ts";

// Pirate Weather Dark-Sky-compatible response types (SI units)
type PirateWeatherHourPoint = {
  time: number;                 // Unix timestamp (UTC)
  summary?: string;
  icon?: string;
  precipIntensity?: number;     // mm/h
  precipProbability?: number;   // 0–1
  precipType?: string;
  temperature?: number;         // °C
  apparentTemperature?: number; // °C
  dewPoint?: number;            // °C
  humidity?: number;            // 0–1
  pressure?: number;            // hPa
  windSpeed?: number;           // m/s
  windGust?: number;            // m/s
  windBearing?: number;         // degrees
  cloudCover?: number;          // 0–1
  uvIndex?: number;
  visibility?: number;          // km
  ozone?: number;
};

type PirateWeatherDayPoint = {
  time: number;                   // Unix timestamp (midnight UTC)
  summary?: string;
  icon?: string;
  precipIntensity?: number;       // mm/h (mean)
  precipProbability?: number;     // 0–1
  precipType?: string;
  temperatureHigh?: number;       // °C
  temperatureLow?: number;        // °C
  temperatureMin?: number;        // °C
  temperatureMax?: number;        // °C
  windSpeed?: number;             // m/s
  windGust?: number;              // m/s
  windBearing?: number;
  cloudCover?: number;
  uvIndex?: number;
  visibility?: number;
  humidity?: number;
  dewPoint?: number;
  pressure?: number;
};

type PirateWeatherResponse = {
  latitude: number;
  longitude: number;
  timezone: string;
  currently?: Record<string, unknown>;
  hourly?: {
    summary?: string;
    data: PirateWeatherHourPoint[];
  };
  daily?: {
    summary?: string;
    data: PirateWeatherDayPoint[];
  };
  flags?: Record<string, unknown>;
};

function unixToUtcIso(unix: number): string {
  return new Date(unix * 1000).toISOString();
}

function unixToUtcDate(unix: number): string {
  // UTC date string "YYYY-MM-DD" from a Unix timestamp
  const d = new Date(unix * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export async function fetchPirateWeatherForecast(params: {
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

  // Pirate Weather expects: /forecast/{key}/{lat},{lon}?units=si&extend=hourly
  // extend=hourly provides 168 hours (7 days) of hourly data instead of default 48h
  const url = new URL(
    `https://api.pirateweather.net/forecast/${apiKey}/${lat.toFixed(4)},${lon.toFixed(4)}`,
  );
  url.searchParams.set("units", "si");
  // Request 7 days of daily data if needed
  if (days > 2) {
    url.searchParams.set("extend", "hourly");
  }
  // Exclude unnecessary blocks to reduce payload size
  url.searchParams.set("exclude", "currently,minutely,alerts,flags");

  const t0 = performance.now();
  const res = await fetch(url.toString(), {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(12000),
  });
  const latency = Math.round(performance.now() - t0);

  if (!res.ok) {
    throw new Error(`Pirate Weather HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const fetchedAt = new Date().toISOString();
  const data = (await res.json()) as PirateWeatherResponse;

  // ── Hourly ─────────────────────────────────────────────────────────────────
  const cutoffHourlyMs = Date.now() + hours * 3600 * 1000;
  const hourly: WxHourlyPoint[] = [];

  for (const h of data.hourly?.data ?? []) {
    const tMs = h.time * 1000;
    if (tMs > cutoffHourlyMs) break;

    // precipIntensity in Pirate Weather SI is mm/h
    // For hourly sum (mm in 1h), precipIntensity × 1 = mm
    const precip_mm = h.precipIntensity ?? null;
    // visibility is in km; convert to meters
    const visibility_m = h.visibility != null ? h.visibility * 1000 : null;

    hourly.push({
      valid_time: unixToUtcIso(h.time),
      temp_c: h.temperature ?? null,
      feels_like_c: h.apparentTemperature ?? null,
      humidity_pct: h.humidity != null ? h.humidity * 100 : null,
      dewpoint_c: h.dewPoint ?? null,
      pressure_hpa: h.pressure ?? null,
      wind_ms: h.windSpeed ?? null,
      wind_dir_deg: h.windBearing ?? null,
      gust_ms: h.windGust ?? null,
      precip_mm,
      precip_prob: h.precipProbability ?? null,
      snow_mm: h.precipType === "snow" && precip_mm != null ? precip_mm : null,
      cloud_pct: h.cloudCover != null ? h.cloudCover * 100 : null,
      visibility_m,
      uv_index: h.uvIndex ?? null,
      provider: "pirate_weather",
      fetched_at: fetchedAt,
      confidence: 0.8,
    });
  }

  // ── Daily ──────────────────────────────────────────────────────────────────
  const daily: WxDailyPoint[] = [];

  for (const d of (data.daily?.data ?? []).slice(0, days)) {
    // precipIntensity daily is the mean rate (mm/h); convert to daily sum:
    // daily_sum ≈ precipIntensity × 24h (rough; Pirate Weather does not
    // provide precipAccumulation in SI, so we approximate)
    const precip_sum_mm = d.precipIntensity != null
      ? Number((d.precipIntensity * 24).toFixed(2))
      : null;

    daily.push({
      date: unixToUtcDate(d.time), // UTC date from midnight Unix timestamp
      t_min_c: d.temperatureMin ?? d.temperatureLow ?? null,
      t_max_c: d.temperatureMax ?? d.temperatureHigh ?? null,
      precip_sum_mm,
      precip_prob_max: d.precipProbability ?? null,
      wind_max_ms: d.windGust ?? d.windSpeed ?? null,
      uv_max: d.uvIndex ?? null,
      provider: "pirate_weather",
      fetched_at: fetchedAt,
      confidence: 0.8,
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
