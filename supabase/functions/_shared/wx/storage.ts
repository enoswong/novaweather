// 修改說明：快取與時間序列寫入（wx_cache / wx_hourly_series / wx_daily_series）
// 影響文件：supabase/functions/_shared/wx/storage.ts

import type {
  WxDailyPoint,
  WxHourlyPoint,
  WxProvider,
} from "./types.ts";

export function buildCacheKey(args: {
  geohash: string;
  endpoint: string;
  params: Record<string, unknown>;
}): string {
  const { geohash, endpoint, params } = args;
  const parts: string[] = [geohash, endpoint];
  const keys = Object.keys(params).sort();
  for (const k of keys) parts.push(`${k}=${String(params[k])}`);
  return parts.join("|");
}

export async function tryReadCache(
  supabase: any,
  cacheKey: string,
): Promise<{ payload: any; isFresh: boolean } | null> {
  const { data, error } = await supabase
    .from("wx_cache")
    .select("payload,expires_at")
    .eq("cache_key", cacheKey)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  const isFresh = new Date(data.expires_at).getTime() > Date.now();
  return { payload: data.payload, isFresh };
}

export async function writeCache(
  supabase: any,
  args: {
    cache_key: string;
    geohash: string;
    endpoint: string;
    params: Record<string, unknown>;
    payload: any;
    ttlSeconds: number;
    fetched_at: string;
  },
) {
  const expiresAt = new Date(Date.now() + args.ttlSeconds * 1000).toISOString();
  const { error } = await supabase.from("wx_cache").upsert({
    cache_key: args.cache_key,
    geohash: args.geohash,
    endpoint: args.endpoint,
    params: args.params,
    payload: args.payload,
    fetched_at: args.fetched_at,
    expires_at: expiresAt,
  }, { onConflict: "cache_key" });
  if (error) throw error;
}

export async function upsertHourlySeries(
  supabase: any,
  args: {
    geohash: string;
    kind: "forecast" | "observed";
    provider: Exclude<WxProvider, "auto">;
    points: WxHourlyPoint[];
  },
) {
  const rows = args.points.map((p) => ({
    geohash: args.geohash,
    valid_time: p.valid_time,
    kind: args.kind,
    temp_c: p.temp_c,
    feels_like_c: p.feels_like_c,
    humidity_pct: p.humidity_pct,
    dewpoint_c: p.dewpoint_c,
    pressure_hpa: p.pressure_hpa,
    wind_ms: p.wind_ms,
    wind_dir_deg: p.wind_dir_deg,
    gust_ms: p.gust_ms,
    precip_mm: p.precip_mm,
    precip_prob: p.precip_prob,
    snow_mm: p.snow_mm,
    cloud_pct: p.cloud_pct,
    visibility_m: p.visibility_m,
    uv_index: p.uv_index,
    provider: args.provider,
    fetched_at: p.fetched_at,
    confidence: p.confidence,
  }));
  if (rows.length === 0) return;

  const { error } = await supabase.from("wx_hourly_series").upsert(rows, {
    onConflict: "geohash,valid_time,kind,provider",
  });
  if (error) throw error;
}

export async function upsertDailySeries(
  supabase: any,
  args: {
    geohash: string;
    provider: Exclude<WxProvider, "auto">;
    points: WxDailyPoint[];
    // date_tz: IANA timezone of the date column.
    // Open-Meteo (primary) and Tomorrow.io/OpenWeather use UTC.
    // WeatherAPI (backup) uses the location's local timezone.
    date_tz?: string;
  },
) {
  const dateTz = args.date_tz ?? "UTC";
  const rows = args.points.map((p) => ({
    geohash: args.geohash,
    date: p.date,
    date_tz: dateTz,
    t_min_c: p.t_min_c,
    t_max_c: p.t_max_c,
    precip_sum_mm: p.precip_sum_mm,
    precip_prob_max: p.precip_prob_max,
    wind_max_ms: p.wind_max_ms,
    uv_max: p.uv_max,
    provider: args.provider,
    fetched_at: p.fetched_at,
    confidence: p.confidence,
  }));
  if (rows.length === 0) return;

  const { error } = await supabase.from("wx_daily_series").upsert(rows, {
    onConflict: "geohash,date,provider",
  });
  if (error) throw error;
}

export async function recordIngestRun(
  supabase: any,
  args: {
    provider: string;
    geohash: string;
    endpoint: string;
    status: "ok" | "error" | "skipped";
    latency_ms: number | null;
    http_status: number | null;
    error: string | null;
  },
) {
  const { error } = await supabase.from("wx_ingest_runs").insert({
    provider: args.provider,
    geohash: args.geohash,
    endpoint: args.endpoint,
    finished_at: new Date().toISOString(),
    latency_ms: args.latency_ms,
    status: args.status,
    http_status: args.http_status,
    error: args.error,
  });
  if (error) throw error;
}

