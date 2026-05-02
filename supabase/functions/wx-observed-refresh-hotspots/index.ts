// 修改說明：Cron 任務：定時抓取熱點 current/observed，寫入 wx_hourly_series(kind=observed)
// 影響文件：supabase/functions/wx-observed-refresh-hotspots/index.ts

import { jsonError, jsonResponse } from "../_shared/wx/http.ts";
import { getSupabaseAdminClient } from "../_shared/wx/supabase.ts";

function toIsoHour(d: Date): string {
  const dd = new Date(d);
  dd.setUTCMinutes(0, 0, 0);
  return dd.toISOString();
}

function kphToMs(kph: unknown): number | null {
  return typeof kph === "number" && Number.isFinite(kph) ? (kph * 1000) / 3600 : null;
}

async function fetchOpenMeteoCurrent(lat: number, lon: number) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,pressure_msl,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,visibility,uv_index",
  );
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("temperature_unit", "celsius");
  url.searchParams.set("wind_speed_unit", "ms");
  url.searchParams.set("precipitation_unit", "mm");

  const t0 = performance.now();
  const res = await fetch(url);
  const latency = Math.round(performance.now() - t0);
  if (!res.ok) throw new Error(`Open-Meteo current HTTP ${res.status}`);
  const fetchedAt = new Date().toISOString();
  const data = await res.json();
  const c = data.current ?? {};

  return {
    provider: "open_meteo",
    fetched_at: fetchedAt,
    latency,
    point: {
      valid_time: toIsoHour(new Date()),
      temp_c: c.temperature_2m ?? null,
      feels_like_c: c.apparent_temperature ?? null,
      humidity_pct: c.relative_humidity_2m ?? null,
      dewpoint_c: c.dew_point_2m ?? null,
      pressure_hpa: c.pressure_msl ?? null,
      wind_ms: c.wind_speed_10m ?? null,
      wind_dir_deg: c.wind_direction_10m ?? null,
      gust_ms: c.wind_gusts_10m ?? null,
      precip_mm: c.precipitation ?? null,
      precip_prob: null,
      snow_mm: null,
      cloud_pct: c.cloud_cover ?? null,
      visibility_m: c.visibility ?? null,
      uv_index: c.uv_index ?? null,
      confidence: 0.7,
    },
  };
}

async function fetchWeatherApiCurrent(apiKey: string, lat: number, lon: number) {
  const url = new URL("https://api.weatherapi.com/v1/current.json");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("q", `${lat},${lon}`);
  url.searchParams.set("aqi", "no");

  const t0 = performance.now();
  const res = await fetch(url);
  const latency = Math.round(performance.now() - t0);
  if (!res.ok) throw new Error(`WeatherAPI current HTTP ${res.status}`);
  const fetchedAt = new Date().toISOString();
  const data = await res.json();
  const cur = data.current ?? {};

  return {
    provider: "weatherapi",
    fetched_at: fetchedAt,
    latency,
    point: {
      valid_time: toIsoHour(new Date()),
      temp_c: cur.temp_c ?? null,
      feels_like_c: cur.feelslike_c ?? null,
      humidity_pct: cur.humidity ?? null,
      dewpoint_c: null,
      pressure_hpa: cur.pressure_mb ?? null,
      wind_ms: kphToMs(cur.wind_kph),
      wind_dir_deg: cur.wind_degree ?? null,
      gust_ms: kphToMs(cur.gust_kph),
      precip_mm: cur.precip_mm ?? null,
      precip_prob: null,
      snow_mm: null,
      cloud_pct: cur.cloud ?? null,
      visibility_m: cur.vis_km == null ? null : cur.vis_km * 1000,
      uv_index: cur.uv ?? null,
      confidence: 0.8,
    },
  };
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

    const supabase = getSupabaseAdminClient();
    const { data: hotspots, error } = await supabase
      .from("wx_hotspots")
      .select("geohash,lat,lon,priority")
      .order("priority", { ascending: false })
      .limit(300);
    if (error) throw error;

    const weatherApiKey = Deno.env.get("WEATHER_API_KEY");
    let written = 0;

    for (const hs of hotspots ?? []) {
      const geohash = hs.geohash;
      try {
        const r = weatherApiKey
          ? await fetchWeatherApiCurrent(weatherApiKey, hs.lat, hs.lon)
          : await fetchOpenMeteoCurrent(hs.lat, hs.lon);

        const p = r.point;
        const { error: upErr } = await supabase.from("wx_hourly_series").upsert({
          geohash,
          valid_time: p.valid_time,
          kind: "observed",
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
          provider: r.provider,
          fetched_at: r.fetched_at,
          confidence: p.confidence,
        }, { onConflict: "geohash,valid_time,kind,provider" });
        if (upErr) throw upErr;

        await supabase.from("wx_ingest_runs").insert({
          provider: r.provider,
          geohash,
          endpoint: "cron_observed_refresh_hotspots",
          finished_at: new Date().toISOString(),
          latency_ms: Number.isFinite(r.latency) ? r.latency : null,
          status: "ok",
          http_status: 200,
          error: null,
        });

        written++;
      } catch (e) {
        await supabase.from("wx_ingest_runs").insert({
          provider: "observed",
          geohash,
          endpoint: "cron_observed_refresh_hotspots",
          finished_at: new Date().toISOString(),
          latency_ms: null,
          status: "error",
          http_status: null,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return jsonResponse({ ok: true, written });
  } catch (e) {
    return jsonError(e);
  }
});

