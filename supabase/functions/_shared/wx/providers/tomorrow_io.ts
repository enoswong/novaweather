// 修改說明：Tomorrow.io provider adapter（備援 2）
// 影響文件：supabase/functions/_shared/wx/providers/tomorrow_io.ts

import type { WxDailyPoint, WxHourlyPoint } from "../types.ts";

type TomorrowTimeline = {
  time: string;
  values: Record<string, number | null | undefined>;
};

type TomorrowResponse = {
  data?: {
    timelines?: Array<{
      timestep: string;
      intervals: TomorrowTimeline[];
    }>;
  };
};

function prob01(v: unknown): number | null {
  if (typeof v !== "number") return null;
  if (!Number.isFinite(v)) return null;
  // Tomorrow.io precipitationProbability 常見為 0..100（百分比）
  const p = v > 1 ? v / 100 : v;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

export async function fetchTomorrowIoForecast(params: {
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

  const url = new URL("https://api.tomorrow.io/v4/timelines");
  url.searchParams.set("location", `${lat},${lon}`);
  url.searchParams.set("apikey", apiKey);
  // 取 hourly + daily
  url.searchParams.set("timesteps", "1h,1d");
  url.searchParams.set(
    "fields",
    [
      "temperature",
      "temperatureApparent",
      "humidity",
      "dewPoint",
      "pressureSeaLevel",
      "windSpeed",
      "windDirection",
      "windGust",
      "precipitationIntensity",
      "precipitationProbability",
      "cloudCover",
      "visibility",
      "uvIndex",
      "temperatureMin",
      "temperatureMax",
      "precipitationAccumulation",
      "windSpeedMax",
      "uvIndexMax",
    ].join(","),
  );

  // 時間窗口（Tomorrow.io 允許 startTime/endTime）
  const now = new Date();
  const end = new Date(now.getTime() + Math.max(hours, days * 24) * 3600 * 1000);
  url.searchParams.set("startTime", now.toISOString());
  url.searchParams.set("endTime", end.toISOString());
  url.searchParams.set("units", "metric");

  const t0 = performance.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const latency = Math.round(performance.now() - t0);
  if (!res.ok) throw new Error(`Tomorrow.io HTTP ${res.status}`);

  const fetchedAt = new Date().toISOString();
  const data = (await res.json()) as TomorrowResponse;
  const timelines = data.data?.timelines ?? [];

  const hourly: WxHourlyPoint[] = [];
  const daily: WxDailyPoint[] = [];

  for (const tl of timelines) {
    if (tl.timestep === "1h") {
      for (const it of tl.intervals ?? []) {
        const v = it.values ?? {};
        hourly.push({
          valid_time: new Date(it.time).toISOString(),
          temp_c: (v.temperature as number | undefined) ?? null,
          feels_like_c: (v.temperatureApparent as number | undefined) ?? null,
          humidity_pct: (v.humidity as number | undefined) ?? null,
          dewpoint_c: (v.dewPoint as number | undefined) ?? null,
          pressure_hpa: (v.pressureSeaLevel as number | undefined) ?? null,

          wind_ms: (v.windSpeed as number | undefined) ?? null,
          wind_dir_deg: (v.windDirection as number | undefined) ?? null,
          gust_ms: (v.windGust as number | undefined) ?? null,

          precip_mm: (v.precipitationIntensity as number | undefined) ?? null,
          precip_prob: prob01(v.precipitationProbability),
          snow_mm: null,

          cloud_pct: (v.cloudCover as number | undefined) ?? null,
          visibility_m: v.visibility == null ? null : (v.visibility as number) * 1000,
          uv_index: (v.uvIndex as number | undefined) ?? null,

          provider: "tomorrow_io",
          fetched_at: fetchedAt,
          confidence: 0.75,
        });
      }
    }

    if (tl.timestep === "1d") {
      for (const it of tl.intervals ?? []) {
        const v = it.values ?? {};
        const date = new Date(it.time);
        const yyyy = date.getUTCFullYear();
        const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(date.getUTCDate()).padStart(2, "0");
        daily.push({
          date: `${yyyy}-${mm}-${dd}`,
          t_min_c: (v.temperatureMin as number | undefined) ?? null,
          t_max_c: (v.temperatureMax as number | undefined) ?? null,
          precip_sum_mm: (v.precipitationAccumulation as number | undefined) ?? null,
          precip_prob_max: null,
          wind_max_ms: (v.windSpeedMax as number | undefined) ?? null,
          uv_max: (v.uvIndexMax as number | undefined) ?? null,
          provider: "tomorrow_io",
          fetched_at: fetchedAt,
          confidence: 0.75,
        });
      }
    }
  }

  hourly.sort((a, b) => a.valid_time.localeCompare(b.valid_time));
  const hourlyTrimmed = hourly.slice(0, Math.max(0, hours));
  const dailyTrimmed = daily.slice(0, Math.max(1, days));

  return {
    timezone: "UTC",
    fetched_at: fetchedAt,
    hourly: hourlyTrimmed,
    daily: dailyTrimmed,
    source_latency_ms: Number.isFinite(latency) ? latency : null,
  };
}

