// wx-compare: side-by-side weather comparison for up to 5 locations
// GET /wx-compare?locations=lat1,lon1[,label]|lat2,lon2[,label]|...
// Returns current conditions + 3-day daily forecast per location with delta analysis.

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-client-info,apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=600, stale-while-revalidate=1200",
    },
  });
}

function round1(n: number | null): number | null {
  return n == null ? null : Math.round(n * 10) / 10;
}

async function fetchCurrentForLocation(lat: number, lon: number, label: string) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation,weather_code,cloud_cover,uv_index,apparent_temperature");
  url.searchParams.set("daily", "temperature_2m_min,temperature_2m_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,uv_index_max,sunrise,sunset");
  url.searchParams.set("forecast_days", "3");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("wind_speed_unit", "ms");

  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status} for ${label}`);
  const data = await res.json();
  const cur = data.current ?? {};
  const daily = data.daily ?? {};

  return {
    label,
    lat,
    lon,
    timezone: data.timezone ?? "UTC",
    current: {
      temp_c: round1(cur.temperature_2m),
      apparent_temp_c: round1(cur.apparent_temperature),
      humidity_pct: cur.relative_humidity_2m ?? null,
      wind_ms: round1(cur.wind_speed_10m),
      cloud_pct: cur.cloud_cover ?? null,
      uv_index: round1(cur.uv_index),
      precip_mm: round1(cur.precipitation),
      weather_code: cur.weather_code ?? null,
    },
    daily: (daily.time ?? []).map((date: string, i: number) => ({
      date,
      t_min_c: round1(daily.temperature_2m_min?.[i]),
      t_max_c: round1(daily.temperature_2m_max?.[i]),
      precip_sum_mm: round1(daily.precipitation_sum?.[i]),
      precip_prob_max: daily.precipitation_probability_max?.[i] ?? null,
      wind_max_ms: round1(daily.wind_speed_10m_max?.[i]),
      uv_max: round1(daily.uv_index_max?.[i]),
      sunrise: daily.sunrise?.[i] ?? null,
      sunset: daily.sunset?.[i] ?? null,
    })),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET") return json({ error: "GET required" }, 405);

  const url = new URL(req.url);
  const locationsRaw = url.searchParams.get("locations") ?? "";

  const parsed: Array<{ lat: number; lon: number; label: string }> = [];
  for (const part of locationsRaw.split("|")) {
    const segs = part.trim().split(",");
    if (segs.length < 2) continue;
    const lat = parseFloat(segs[0]), lon = parseFloat(segs[1]);
    if (isNaN(lat) || isNaN(lon)) continue;
    const label = segs[2]?.trim() || `${lat},${lon}`;
    parsed.push({ lat, lon, label });
    if (parsed.length >= 5) break;
  }

  if (parsed.length < 2) {
    return json({ error: "Need at least 2 valid locations in format: lat1,lon1|lat2,lon2 (max 5)" }, 400);
  }

  const results = await Promise.allSettled(
    parsed.map(({ lat, lon, label }) => fetchCurrentForLocation(lat, lon, label))
  );

  const locations: unknown[] = [];
  const errors: string[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") locations.push(r.value);
    else errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
  }

  let delta: Record<string, unknown> | null = null;
  if (locations.length >= 2) {
    const a = (locations[0] as any).current;
    const b = (locations[1] as any).current;
    delta = {
      temp_c: round1((b.temp_c ?? 0) - (a.temp_c ?? 0)),
      humidity_pct: b.humidity_pct != null && a.humidity_pct != null
        ? Math.round(b.humidity_pct - a.humidity_pct) : null,
      wind_ms: round1((b.wind_ms ?? 0) - (a.wind_ms ?? 0)),
      uv_index: round1((b.uv_index ?? 0) - (a.uv_index ?? 0)),
      between: [(locations[0] as any).label, (locations[1] as any).label],
    };
  }

  return json({
    meta: { fetched_at: new Date().toISOString(), count: locations.length },
    locations,
    delta,
    errors: errors.length > 0 ? errors : undefined,
  });
});
