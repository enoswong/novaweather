// wx-anomaly: detect statistical weather anomalies vs historical normals
// GET /wx-anomaly?lat=X&lon=Y
// Samples 7 historical years (Open-Meteo Archive), computes μ+σ for the same
// calendar week, then Z-scores today's values.

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
      "cache-control": "public, max-age=3600, stale-while-revalidate=7200",
    },
  });
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

function anomalyLabel(deviation: number, sigma: number): string {
  const z = Math.abs(deviation) / (sigma || 1);
  if (z < 0.5) return "Normal";
  if (z < 1.0) return "Slightly anomalous";
  if (z < 2.0) return "Anomalous";
  return "Extreme anomaly";
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr: number[], mu: number): number {
  return Math.sqrt(arr.reduce((a, b) => a + (b - mu) ** 2, 0) / arr.length);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET") return json({ error: "GET required" }, 405);

  const url = new URL(req.url);
  const latS = url.searchParams.get("lat"), lonS = url.searchParams.get("lon");
  if (!latS || !lonS) return json({ error: "lat and lon required" }, 400);
  const lat = parseFloat(latS), lon = parseFloat(lonS);
  if (isNaN(lat) || isNaN(lon)) return json({ error: "Invalid lat/lon" }, 400);

  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const todayStr = `${currentYear}-${month}-${day}`;

  // Fetch current conditions
  const curUrl = new URL("https://api.open-meteo.com/v1/forecast");
  curUrl.searchParams.set("latitude", String(lat));
  curUrl.searchParams.set("longitude", String(lon));
  curUrl.searchParams.set("current", "temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m");
  curUrl.searchParams.set("daily", "temperature_2m_min,temperature_2m_max,precipitation_sum");
  curUrl.searchParams.set("forecast_days", "1");
  curUrl.searchParams.set("timezone", "auto");
  curUrl.searchParams.set("wind_speed_unit", "ms");

  // Sample years and window
  const SAMPLE_YEARS = [1994, 1999, 2004, 2009, 2014, 2019, 2023].filter(y => y < currentYear);
  const WINDOW_DAYS = 7;

  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

  const fetchHistorical = async (year: number) => {
    const base = new Date(Date.UTC(year, now.getUTCMonth(), now.getUTCDate()));
    const start = new Date(base.getTime() - WINDOW_DAYS * 86400000);
    const end = new Date(base.getTime() + WINDOW_DAYS * 86400000);
    const u = new URL("https://archive-api.open-meteo.com/v1/archive");
    u.searchParams.set("latitude", String(lat));
    u.searchParams.set("longitude", String(lon));
    u.searchParams.set("start_date", fmt(start));
    u.searchParams.set("end_date", fmt(end));
    u.searchParams.set("daily", "temperature_2m_min,temperature_2m_max,precipitation_sum,wind_speed_10m_max");
    u.searchParams.set("wind_speed_unit", "ms");
    const res = await fetch(u, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`Archive ${year}: HTTP ${res.status}`);
    return (await res.json()).daily ?? {};
  };

  const [curResult, ...histResults] = await Promise.allSettled([
    fetch(curUrl, { signal: AbortSignal.timeout(8000) }).then(r => r.json()),
    ...SAMPLE_YEARS.map(fetchHistorical),
  ]);

  if (curResult.status === "rejected") return json({ error: "Failed to fetch current conditions" }, 502);
  const curData = curResult.value;

  const histTMin: number[] = [], histTMax: number[] = [],
    histPrecip: number[] = [], histWind: number[] = [];
  for (const hr of histResults) {
    if (hr.status === "rejected") continue;
    const d = hr.value;
    for (let i = 0; i < (d.temperature_2m_min ?? []).length; i++) {
      if (d.temperature_2m_min?.[i] != null) histTMin.push(d.temperature_2m_min[i]);
      if (d.temperature_2m_max?.[i] != null) histTMax.push(d.temperature_2m_max[i]);
      if (d.precipitation_sum?.[i] != null) histPrecip.push(d.precipitation_sum[i]);
      if (d.wind_speed_10m_max?.[i] != null) histWind.push(d.wind_speed_10m_max[i]);
    }
  }

  if (histTMin.length === 0) {
    return json({ error: "Could not retrieve historical data for this location" }, 502);
  }

  const muTMin = mean(histTMin), sigmaTMin = stdDev(histTMin, muTMin);
  const muTMax = mean(histTMax), sigmaTMax = stdDev(histTMax, muTMax);
  const muPrecip = mean(histPrecip), sigmaPrecip = stdDev(histPrecip, muPrecip);
  const muWind = mean(histWind), sigmaWind = stdDev(histWind, muWind);

  const todayTMin = curData.daily?.temperature_2m_min?.[0];
  const todayTMax = curData.daily?.temperature_2m_max?.[0];
  const todayPrecip = curData.daily?.precipitation_sum?.[0] ?? 0;

  const deviations: Record<string, unknown> = {};
  const zScores: number[] = [];

  if (todayTMin != null) {
    const dev = todayTMin - muTMin;
    deviations.temp_min_c = { current: round2(todayTMin), normal: round2(muTMin), deviation: round2(dev), sigma: round2(sigmaTMin), anomaly: anomalyLabel(dev, sigmaTMin) };
    if (sigmaTMin > 0) zScores.push(Math.abs(dev / sigmaTMin));
  }
  if (todayTMax != null) {
    const dev = todayTMax - muTMax;
    deviations.temp_max_c = { current: round2(todayTMax), normal: round2(muTMax), deviation: round2(dev), sigma: round2(sigmaTMax), anomaly: anomalyLabel(dev, sigmaTMax) };
    if (sigmaTMax > 0) zScores.push(Math.abs(dev / sigmaTMax));
  }
  if (todayPrecip != null) {
    const dev = todayPrecip - muPrecip;
    deviations.precip_mm = { current: round2(todayPrecip), normal: round2(muPrecip), deviation: round2(dev), sigma: round2(sigmaPrecip), anomaly: anomalyLabel(dev, sigmaPrecip) };
  }

  const maxZ = zScores.length > 0 ? Math.max(...zScores) : 0;
  const overall = maxZ < 0.5 ? "Normal" : maxZ < 1.0 ? "Slightly anomalous" : maxZ < 2.0 ? "Anomalous" : "Extreme anomaly";

  return json({
    meta: {
      lat, lon,
      reference_date: todayStr,
      historical_years: SAMPLE_YEARS,
      historical_window_days: WINDOW_DAYS * 2 + 1,
      sample_count: histTMin.length,
      fetched_at: new Date().toISOString(),
    },
    overall_anomaly: overall,
    max_z_score: round2(maxZ),
    deviations,
    normals: {
      temp_min_c: round2(muTMin),
      temp_max_c: round2(muTMax),
      precip_mm: round2(muPrecip),
      wind_max_ms: round2(muWind),
    },
  });
});
