// wx-indices: composite weather indices for app consumption
// GET /wx-indices?lat=X&lon=Y
// Returns: comfort, health, outdoor, energy indices + apparent_temp, frost/heat risk
// Derives current + 24h hourly indices from Open-Meteo forecast. No API key required.

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-client-info,apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=900, stale-while-revalidate=1800" },
  });
}

function heatIndex(t: number, rh: number): number {
  if (t < 27) return t;
  const T = t * 9 / 5 + 32;
  const HI = -42.379 + 2.04901523 * T + 10.14333127 * rh - 0.22475541 * T * rh
    - 0.00683783 * T * T - 0.05481717 * rh * rh + 0.00122874 * T * T * rh
    + 0.00085282 * T * rh * rh - 0.00000199 * T * T * rh * rh;
  return (HI - 32) * 5 / 9;
}

function windChill(t: number, wms: number): number {
  if (t > 10 || wms <= 1.3) return t;
  const wkph = wms * 3.6;
  return 13.12 + 0.6215 * t - 11.37 * Math.pow(wkph, 0.16) + 0.3965 * t * Math.pow(wkph, 0.16);
}

function comfortIndex(t: number, rh: number, wms: number): { score: number; label: string } {
  const tempScore = Math.max(0, 100 - Math.abs(t - 22) * 5);
  const humScore = Math.max(0, 100 - Math.abs(rh - 50) * 1.5);
  const windScore = wms < 1 ? 80 : wms < 6 ? 100 : wms < 10 ? 70 : 40;
  const score = Math.round(tempScore * 0.5 + humScore * 0.3 + windScore * 0.2);
  const label = score >= 80 ? "Comfortable" : score >= 60 ? "Acceptable" : score >= 40 ? "Uncomfortable" : "Severe";
  return { score, label };
}

function healthIndex(t: number, rh: number, uv: number, aqi: number | null): { score: number; label: string; risks: string[] } {
  const risks: string[] = [];
  let penalty = 0;
  if (t > 35) { risks.push("heat_stress"); penalty += 30; }
  else if (t < 0) { risks.push("cold_stress"); penalty += 20; }
  if (rh > 80) { risks.push("high_humidity"); penalty += 15; }
  else if (rh < 25) { risks.push("very_dry"); penalty += 10; }
  if (uv >= 11) { risks.push("extreme_uv"); penalty += 30; }
  else if (uv >= 8) { risks.push("very_high_uv"); penalty += 15; }
  else if (uv >= 6) { risks.push("high_uv"); penalty += 5; }
  if (aqi != null) {
    if (aqi > 200) { risks.push("very_unhealthy_air"); penalty += 40; }
    else if (aqi > 150) { risks.push("unhealthy_air"); penalty += 25; }
    else if (aqi > 100) { risks.push("sensitive_air"); penalty += 10; }
  }
  const score = Math.max(0, Math.min(100, 100 - penalty));
  const label = score >= 80 ? "Good" : score >= 60 ? "Moderate" : score >= 40 ? "Poor" : "Hazardous";
  return { score, label, risks };
}

function outdoorIndex(t: number, rh: number, wms: number, precip_prob: number, uv: number): { score: number; label: string } {
  let score = 100;
  score -= precip_prob * 40;
  if (t < 5 || t > 35) score -= 25; else if (t < 10 || t > 30) score -= 10;
  if (wms > 15) score -= 20; else if (wms > 8) score -= 8;
  if (uv >= 8) score -= 10;
  if (rh > 85) score -= 10;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const label = score >= 75 ? "Excellent" : score >= 55 ? "Good" : score >= 35 ? "Fair" : "Poor";
  return { score, label };
}

function energyIndex(t: number, cloud_pct: number): { cooling_demand: number; heating_demand: number; solar_potential: string } {
  const cooling_demand = Math.max(0, Math.round((t - 18) * 10)) / 10;
  const heating_demand = Math.max(0, Math.round((18 - t) * 10)) / 10;
  const solar_potential = cloud_pct < 25 ? "High" : cloud_pct < 60 ? "Moderate" : "Low";
  return { cooling_demand, heating_demand, solar_potential };
}

function uvCategory(uv: number): string {
  if (uv < 3) return "Low";
  if (uv < 6) return "Moderate";
  if (uv < 8) return "High";
  if (uv < 11) return "Very High";
  return "Extreme";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET") return json({ error: "GET required" }, 405);

  const url = new URL(req.url);
  const latS = url.searchParams.get("lat"), lonS = url.searchParams.get("lon");
  if (!latS || !lonS) return json({ error: "lat and lon required" }, 400);
  const lat = parseFloat(latS), lon = parseFloat(lonS);
  if (isNaN(lat) || isNaN(lon)) return json({ error: "Invalid lat/lon" }, 400);

  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.searchParams.set("latitude", String(lat));
  forecastUrl.searchParams.set("longitude", String(lon));
  forecastUrl.searchParams.set("current", "temperature_2m,relative_humidity_2m,wind_speed_10m,cloud_cover,uv_index,precipitation_probability,apparent_temperature");
  forecastUrl.searchParams.set("hourly", "temperature_2m,relative_humidity_2m,wind_speed_10m,cloud_cover,uv_index,precipitation_probability");
  forecastUrl.searchParams.set("forecast_hours", "24");
  forecastUrl.searchParams.set("timezone", "auto");
  forecastUrl.searchParams.set("wind_speed_unit", "ms");

  const aqUrl = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
  aqUrl.searchParams.set("latitude", String(lat));
  aqUrl.searchParams.set("longitude", String(lon));
  aqUrl.searchParams.set("current", "us_aqi");

  const [fRes, aqRes] = await Promise.allSettled([
    fetch(forecastUrl, { signal: AbortSignal.timeout(8000) }),
    fetch(aqUrl, { signal: AbortSignal.timeout(6000) }),
  ]);

  if (fRes.status === "rejected" || (fRes.status === "fulfilled" && !fRes.value.ok)) {
    return json({ error: "Failed to fetch weather data" }, 502);
  }

  const fData = await fRes.value.json();
  const cur = fData.current ?? {};
  const fetchedAt = new Date().toISOString();

  const t: number = cur.temperature_2m ?? 20;
  const rh: number = cur.relative_humidity_2m ?? 50;
  const wms: number = cur.wind_speed_10m ?? 0;
  const cloud: number = cur.cloud_cover ?? 50;
  const uv: number = cur.uv_index ?? 0;
  const precipProb: number = (cur.precipitation_probability ?? 0) / 100;
  const apparentT: number = cur.apparent_temperature ?? t;

  let usAqi: number | null = null;
  if (aqRes.status === "fulfilled" && aqRes.value.ok) {
    const aqData = await aqRes.value.json();
    usAqi = aqData.current?.us_aqi ?? null;
  }

  const comfort = comfortIndex(t, rh, wms);
  const health = healthIndex(t, rh, uv, usAqi);
  const outdoor = outdoorIndex(t, rh, wms, precipProb, uv);
  const energy = energyIndex(t, cloud);
  const heatI = t >= 27 ? Math.round(heatIndex(t, rh) * 10) / 10 : null;
  const windC = t <= 10 && wms > 1.3 ? Math.round(windChill(t, wms) * 10) / 10 : null;

  const h = fData.hourly ?? {};
  const hourlyIndices = [];
  if (h.time?.length) {
    for (let i = 0; i < Math.min(24, h.time.length); i++) {
      const ht = h.temperature_2m?.[i] ?? 20;
      const hrh = h.relative_humidity_2m?.[i] ?? 50;
      const hwms = h.wind_speed_10m?.[i] ?? 0;
      const huv = h.uv_index?.[i] ?? 0;
      const hprecip = (h.precipitation_probability?.[i] ?? 0) / 100;
      hourlyIndices.push({
        time: h.time[i],
        comfort: comfortIndex(ht, hrh, hwms).score,
        outdoor: outdoorIndex(ht, hrh, hwms, hprecip, huv).score,
        uv_index: huv,
        uv_category: uvCategory(huv),
      });
    }
  }

  return json({
    meta: { lat, lon, fetched_at: fetchedAt, provider: "open_meteo" },
    current: {
      temp_c: t,
      apparent_temp_c: apparentT,
      humidity_pct: rh,
      wind_ms: wms,
      cloud_pct: cloud,
      uv_index: uv,
      uv_category: uvCategory(uv),
      us_aqi: usAqi,
      heat_index_c: heatI,
      wind_chill_c: windC,
      frost_risk: t <= 3 ? (t <= 0 ? "High" : "Moderate") : "Low",
      heat_risk: t >= 38 ? "High" : t >= 33 ? "Moderate" : "Low",
    },
    indices: { comfort, health, outdoor, energy },
    hourly: hourlyIndices,
  });
});
