// 修改說明：新增 /wx-region（country_code + region_code）並支援 minute/hourly/daily/all 粒度輸出
// 影響文件：supabase/functions/wx-region/index.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-client-info,apikey",
};

type Granularity = "all" | "minute" | "hourly" | "daily";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function parseBool(v: string | null, d = true): boolean {
  if (v == null) return d;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return d;
}

function parseIntRange(raw: string | null, d: number, min: number, max: number, name: string): number {
  const n = raw == null ? d : Number(raw);
  if (!Number.isInteger(n)) throw new Error(`Invalid integer: ${name}`);
  if (n < min || n > max) throw new Error(`Out of range: ${name}`);
  return n;
}

function nowUtcDate(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function normalizeRiskPayload(riskPayload: any) {
  const reasons = Array.isArray(riskPayload?.reasons) ? riskPayload.reasons : [];
  const riskLevel = Number.isInteger(riskPayload?.risk_level) ? riskPayload.risk_level : 0;
  const tags = new Set<string>();
  for (const r of reasons) {
    const code = String(r?.code ?? "");
    if (code === "heavy_rain_prob") tags.add("rain");
    if (code === "strong_wind") tags.add("windy");
    if (code === "storm_condition") tags.add("storm");
    if (code === "dry_air" || code === "humidity_lt_40") tags.add("dry");
    if (code === "humidity_gt_90") tags.add("humid");
    if (code === "heat_extreme") tags.add("hot");
    if (code === "cold_extreme") tags.add("cold");
    if (code === "official_alert") tags.add("official-alert");
  }
  if (tags.size === 0) tags.add("stable");
  return { risk_level: riskLevel, reasons, tags: Array.from(tags) };
}

function lerp(a: number | null, b: number | null, t: number): number | null {
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  return a + (b - a) * t;
}

function num(v: unknown): number | null {
  if (typeof v !== "number") return null;
  if (!Number.isFinite(v)) return null;
  return v;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  try {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRole) return json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);
    const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

    const url = new URL(req.url);
    const countryCode = (url.searchParams.get("country_code") ?? "").trim().toUpperCase();
    const regionCode = (url.searchParams.get("region_code") ?? "").trim().toLowerCase();
    const granularity = ((url.searchParams.get("granularity") ?? "all").trim().toLowerCase()) as Granularity;
    if (!countryCode) return json({ error: "Missing query param: country_code" }, 400);
    if (!regionCode) return json({ error: "Missing query param: region_code" }, 400);
    if (!["all", "minute", "hourly", "daily"].includes(granularity)) return json({ error: "Invalid granularity" }, 400);

    const minuteWindow = parseIntRange(url.searchParams.get("minute_window"), 60, 5, 180, "minute_window");
    const hours = parseIntRange(url.searchParams.get("hours"), 72, 1, 168, "hours");
    const days = parseIntRange(url.searchParams.get("days"), 7, 1, 16, "days");
    const windowHours = parseIntRange(url.searchParams.get("window_hours"), 24, 1, 168, "window_hours");
    const radiusKm = parseIntRange(url.searchParams.get("radius_km"), 50, 1, 500, "radius_km");
    const provider = (url.searchParams.get("provider") ?? "auto").trim();
    const allowLiveFetch = parseBool(url.searchParams.get("allow_live_fetch"), true);

    const cacheKey = [
      "wx-region",
      countryCode,
      regionCode,
      granularity,
      `m=${minuteWindow}`,
      `h=${hours}`,
      `d=${days}`,
      `w=${windowHours}`,
      `r=${radiusKm}`,
      `p=${provider}`,
      `live=${allowLiveFetch ? "1" : "0"}`,
    ].join("|");
    const { data: cached } = await supabase
      .from("wx_region_cache")
      .select("payload,expires_at")
      .eq("cache_key", cacheKey)
      .maybeSingle();
    if (cached && new Date(cached.expires_at).getTime() > Date.now()) {
      return json(cached.payload);
    }

    const { data: regionRow, error: regionErr } = await supabase
      .from("wx_region_codes")
      .select("country_code,region_code,region_name,geohash,lat,lon,timezone,admin1,admin2,admin3,admin4,locality,name,place_id")
      .eq("country_code", countryCode)
      .eq("region_code", regionCode)
      .maybeSingle();
    if (regionErr) throw regionErr;
    if (!regionRow) return json({ error: "Unknown region_code for country_code" }, 404);

    const lat = regionRow.lat;
    const lon = regionRow.lon;
    const geohash = regionRow.geohash;

    const q = new URLSearchParams();
    q.set("lat", String(lat));
    q.set("lon", String(lon));
    q.set("provider", provider);
    q.set("allow_live_fetch", allowLiveFetch ? "true" : "false");

    const hourlyUrl = `${supabaseUrl}/functions/v1/wx-forecast-hourly?${q.toString()}&hours=${hours}`;
    const dailyUrl = `${supabaseUrl}/functions/v1/wx-forecast-daily?${q.toString()}&days=${days}`;
    const observedUrl = `${supabaseUrl}/functions/v1/wx-observed-now?${q.toString()}`;
    const alertsUrl = `${supabaseUrl}/functions/v1/wx-alerts?${q.toString()}&radius_km=${radiusKm}`;
    const riskUrl = `${supabaseUrl}/functions/v1/wx-risk?${q.toString()}&window_hours=${windowHours}&radius_km=${radiusKm}`;

    const [hourlyRes, dailyRes, observedRes, alertsRes, riskRes] = await Promise.all([
      fetch(hourlyUrl),
      fetch(dailyUrl),
      fetch(observedUrl),
      fetch(alertsUrl),
      fetch(riskUrl),
    ]);

    if (!hourlyRes.ok) return json({ error: "hourly failed", detail: await hourlyRes.text() }, hourlyRes.status);
    if (!dailyRes.ok) return json({ error: "daily failed", detail: await dailyRes.text() }, dailyRes.status);
    if (!observedRes.ok) return json({ error: "observed failed", detail: await observedRes.text() }, observedRes.status);
    if (!alertsRes.ok) return json({ error: "alerts failed", detail: await alertsRes.text() }, alertsRes.status);
    if (!riskRes.ok) return json({ error: "risk failed", detail: await riskRes.text() }, riskRes.status);

    const hourlyPayload = await hourlyRes.json();
    const dailyPayload = await dailyRes.json();
    const observedPayload = await observedRes.json();
    const alertsPayload = await alertsRes.json();
    const riskPayload = await riskRes.json();

    const hourly = Array.isArray(hourlyPayload?.hourly) ? hourlyPayload.hourly : [];
    const daily = Array.isArray(dailyPayload?.daily) ? dailyPayload.daily : [];
    const observed = observedPayload?.observed ?? null;
    const alerts = Array.isArray(alertsPayload?.alerts) ? alertsPayload.alerts : [];
    const risk = normalizeRiskPayload(riskPayload);

    const first = hourly[0] ?? observed ?? null;
    const start = observed ?? first;
    const minute: any[] = [];
    if (start) {
      const startTemp = num(start.temp_c);
      const endTemp = num(first?.temp_c);
      const startHum = num(start.humidity_pct);
      const endHum = num(first?.humidity_pct);
      const startProb = num(start.precip_prob);
      const endProb = num(first?.precip_prob);
      const startWind = num(start.wind_ms);
      const endWind = num(first?.wind_ms);
      const startGust = num(start.gust_ms);
      const endGust = num(first?.gust_ms);
      const nowMs = Date.now();
      for (let i = 1; i <= minuteWindow; i++) {
        const t = i / minuteWindow;
        minute.push({
          valid_time: new Date(nowMs + i * 60 * 1000).toISOString(),
          temp_c: lerp(startTemp, endTemp, t),
          humidity_pct: lerp(startHum, endHum, t),
          precip_prob: lerp(startProb, endProb, t),
          wind_ms: lerp(startWind, endWind, t),
          gust_ms: lerp(startGust, endGust, t),
          risk,
        });
      }
    }

    const response: Record<string, unknown> = {
      meta: {
        fetched_at: new Date().toISOString(),
        country_code: countryCode,
        region_code: regionCode,
        region_name: regionRow.region_name,
        granularity,
        timezone: regionRow.timezone,
        geohash,
        lat,
        lon,
        admin1: regionRow.admin1,
        admin2: regionRow.admin2,
        admin3: regionRow.admin3,
        admin4: regionRow.admin4,
        locality: regionRow.locality,
        name: regionRow.name,
        place_id: regionRow.place_id,
        window_hours: windowHours,
        minute_window: minuteWindow,
        hours,
        days,
        radius_km: radiusKm,
      },
      now: { observed, risk },
      alerts_summary: { active_count: alerts.length },
      alerts,
    };

    if (granularity === "all" || granularity === "minute") response.minute = minute;
    if (granularity === "all" || granularity === "hourly") response.hourly = hourly.map((h: any) => ({ ...h, risk }));
    if (granularity === "all" || granularity === "daily") response.daily = daily.map((d: any) => ({ ...d, risk }));

    const ttl = granularity === "minute" || granularity === "all" ? 120 : granularity === "hourly" ? 300 : 900;
    await supabase.from("wx_region_cache").upsert({
      cache_key: cacheKey,
      country_code: countryCode,
      region_code: regionCode,
      granularity,
      payload: response,
      fetched_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
    }, { onConflict: "cache_key" });

    return json(response);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return json({ error: "Internal error", detail }, 500);
  }
});

