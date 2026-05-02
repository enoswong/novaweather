// wx-bundle: single-request aggregator for multiple wx-* endpoints
// GET /wx-bundle?lat=X&lon=Y&include=forecast_hourly,forecast_daily,observed,aq,marine,alerts,risk,astronomy,metar,solar,environment
// Fans out in parallel; each dataset independently errors without aborting the bundle.

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-client-info,apikey",
};

type DatasetKey =
  | "forecast_hourly"
  | "forecast_daily"
  | "observed"
  | "aq"
  | "marine"
  | "alerts"
  | "risk"
  | "astronomy"
  | "metar"
  | "solar"
  | "environment";

const DATASET_MAP: Record<DatasetKey, string> = {
  forecast_hourly: "wx-forecast-hourly",
  forecast_daily: "wx-forecast-daily",
  observed: "wx-observed-now",
  aq: "wx-air-quality",
  marine: "wx-marine",
  alerts: "wx-alerts",
  risk: "wx-risk",
  astronomy: "wx-astronomy",
  metar: "wx-observed-metar",
  solar: "wx-solar",
  environment: "wx-environment-timeline",
};

const DEFAULT_INCLUDE: DatasetKey[] = [
  "forecast_hourly",
  "forecast_daily",
  "observed",
  "aq",
  "alerts",
  "risk",
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60, stale-while-revalidate=120",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET") return json({ error: "GET required" }, 405);

  const url = new URL(req.url);
  const lat = url.searchParams.get("lat");
  const lon = url.searchParams.get("lon");
  if (!lat || !lon) return json({ error: "lat and lon are required" }, 400);

  const latN = parseFloat(lat);
  const lonN = parseFloat(lon);
  if (isNaN(latN) || isNaN(lonN) || latN < -90 || latN > 90 || lonN < -180 || lonN > 180) {
    return json({ error: "Invalid lat/lon" }, 400);
  }

  const includeRaw = url.searchParams.get("include");
  const requested: DatasetKey[] = includeRaw
    ? (includeRaw.split(",").map((s) => s.trim()).filter((s) => s in DATASET_MAP) as DatasetKey[])
    : DEFAULT_INCLUDE;

  if (requested.length === 0) return json({ error: "No valid datasets in include" }, 400);

  const baseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!baseUrl) return json({ error: "Missing SUPABASE_URL" }, 500);

  const extraParams = new URLSearchParams();
  for (const [k, v] of url.searchParams.entries()) {
    if (k === "lat" || k === "lon" || k === "include") continue;
    extraParams.set(k, v);
  }

  const fetchDataset = async (key: DatasetKey): Promise<{ key: string; data: unknown; status: number }> => {
    const fnName = DATASET_MAP[key];
    const upstream = new URL(`${baseUrl.replace(/\/$/, "")}/functions/v1/${fnName}`);
    upstream.searchParams.set("lat", lat);
    upstream.searchParams.set("lon", lon);
    for (const [k, v] of extraParams.entries()) upstream.searchParams.set(k, v);

    try {
      const res = await fetch(upstream.toString(), {
        headers: { authorization: `Bearer ${serviceKey}` },
        signal: AbortSignal.timeout(12000),
      });
      const body = await res.json();
      return { key, data: body, status: res.status };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { key, data: { error: msg }, status: 503 };
    }
  };

  const started_at = Date.now();
  const results = await Promise.all(requested.map(fetchDataset));
  const elapsed_ms = Date.now() - started_at;

  const bundle: Record<string, unknown> = {};
  const errors: Record<string, unknown> = {};
  for (const { key, data, status } of results) {
    if (status === 200) {
      bundle[key] = data;
    } else {
      errors[key] = { status, ...(typeof data === "object" && data !== null ? data : { raw: data }) };
    }
  }

  return json({
    meta: {
      lat: latN,
      lon: lonN,
      include: requested,
      elapsed_ms,
      fetched_at: new Date().toISOString(),
    },
    data: bundle,
    errors: Object.keys(errors).length > 0 ? errors : undefined,
  });
});
