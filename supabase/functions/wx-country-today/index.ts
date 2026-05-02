// 修改說明：新增 /wx-country-today（按 country_code 回傳該國地區本日資料，含分頁）
// 影響文件：supabase/functions/wx-country-today/index.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { ensureSeedRegionCodes } from "../_shared/wx/region_codes.ts";

const CORS_HEADERS: Record<string, string> = {
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
      "cache-control": "no-store",
    },
  });
}

function parseIntRange(raw: string | null, d: number, min: number, max: number, name: string): number {
  const n = raw == null ? d : Number(raw);
  if (!Number.isInteger(n)) throw new Error(`Invalid integer: ${name}`);
  if (n < min || n > max) throw new Error(`Out of range: ${name}`);
  return n;
}

function todayUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
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
    if (!countryCode) return json({ error: "Missing query param: country_code" }, 400);
    const page = parseIntRange(url.searchParams.get("page"), 1, 1, 100000, "page");
    const pageSize = parseIntRange(url.searchParams.get("page_size"), 100, 1, 500, "page_size");
    const include = new Set((url.searchParams.get("include") ?? "summary,risk").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
    const radiusKm = parseIntRange(url.searchParams.get("radius_km"), 50, 1, 500, "radius_km");
    const offset = (page - 1) * pageSize;
    const dateToday = todayUtc();

    const cacheKey = ["wx-country-today", countryCode, `p=${page}`, `s=${pageSize}`, `i=${Array.from(include).sort().join("+")}`, `d=${dateToday}`].join("|");
    const { data: cached } = await supabase
      .from("wx_region_cache")
      .select("payload,expires_at")
      .eq("cache_key", cacheKey)
      .maybeSingle();
    if (cached && new Date(cached.expires_at).getTime() > Date.now()) {
      return json(cached.payload);
    }

    const { count, error: countErr } = await supabase
      .from("wx_region_codes")
      .select("id", { count: "exact", head: true })
      .eq("country_code", countryCode);
    if (countErr) throw countErr;

    let { data: regions, error: regionErr } = await supabase
      .from("wx_region_codes")
      .select("country_code,region_code,region_name,geohash,lat,lon,timezone,admin1,admin2,admin3,admin4,locality,name,place_id")
      .eq("country_code", countryCode)
      .order("region_code", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (regionErr) throw regionErr;

    if (!regions || regions.length === 0) {
      // [!note] 重要演算法：若該國尚未有 region_code，先確保種子映射可用，避免回傳空清單。
      await ensureSeedRegionCodes(supabase);
      const refetch = await supabase
        .from("wx_region_codes")
        .select("country_code,region_code,region_name,geohash,lat,lon,timezone,admin1,admin2,admin3,admin4,locality,name,place_id")
        .eq("country_code", countryCode)
        .order("region_code", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (refetch.error) throw refetch.error;
      regions = refetch.data ?? [];
    }

    const nowIso = new Date().toISOString();
    const out = await Promise.all((regions ?? []).map(async (r: any) => {
      const geohash = r.geohash as string;

      const [{ data: observedRows }, { data: dailyRows }, { data: riskRows }] = await Promise.all([
        supabase
          .from("wx_hourly_series")
          .select("valid_time,temp_c,humidity_pct,wind_ms,precip_mm,provider")
          .eq("geohash", geohash)
          .eq("kind", "observed")
          .order("valid_time", { ascending: false })
          .limit(1),
        supabase
          .from("wx_daily_series")
          .select("date,t_min_c,t_max_c,precip_sum_mm,precip_prob_max,wind_max_ms,provider,fetched_at")
          .eq("geohash", geohash)
          .eq("date", dateToday)
          .order("fetched_at", { ascending: false })
          .limit(1),
        supabase
          .from("wx_risk_snapshots")
          .select("risk_level,computed_at")
          .eq("geohash", geohash)
          .gte("computed_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString())
          .order("computed_at", { ascending: false })
          .limit(1),
      ]);

      const observed = (observedRows ?? [])[0] ?? null;
      const today = (dailyRows ?? [])[0] ?? null;
      const risk = (riskRows ?? [])[0] ?? null;

      let activeAlertCount: number | null = null;
      if (include.has("alerts")) {
        const { data: nearby } = await supabase.rpc("wx_alerts_nearby", {
          in_lat: r.lat,
          in_lon: r.lon,
          in_radius_m: radiusKm * 1000,
        });
        activeAlertCount = Array.isArray(nearby) ? nearby.length : 0;
      }

      return {
        country_code: r.country_code,
        region_code: r.region_code,
        region_name: r.region_name,
        geohash: r.geohash,
        timezone: r.timezone,
        admin1: r.admin1,
        admin2: r.admin2,
        admin3: r.admin3,
        admin4: r.admin4,
        locality: r.locality,
        name: r.name,
        place_id: r.place_id,
        observed: include.has("summary")
          ? observed
            ? {
              valid_time: observed.valid_time,
              temp_c: observed.temp_c,
              humidity_pct: observed.humidity_pct,
              wind_ms: observed.wind_ms,
              precip_mm: observed.precip_mm,
              provider: observed.provider,
            }
            : null
          : undefined,
        today: include.has("summary")
          ? today
            ? {
              date: today.date,
              t_min_c: today.t_min_c,
              t_max_c: today.t_max_c,
              precip_sum_mm: today.precip_sum_mm,
              precip_prob_max: today.precip_prob_max,
              wind_max_ms: today.wind_max_ms,
              provider: today.provider,
            }
            : null
          : undefined,
        risk: include.has("risk")
          ? {
            risk_level: Number.isInteger(risk?.risk_level) ? risk.risk_level : 0,
            computed_at: risk?.computed_at ?? null,
          }
          : undefined,
        active_alert_count: include.has("alerts") ? activeAlertCount : undefined,
      };
    }));

    const response = {
      meta: {
        fetched_at: nowIso,
        country_code: countryCode,
        date: dateToday,
        page,
        page_size: pageSize,
        total_regions: count ?? 0,
        total_pages: Math.max(1, Math.ceil((count ?? 0) / pageSize)),
        include: Array.from(include),
      },
      regions: out,
    };

    await supabase.from("wx_region_cache").upsert({
      cache_key: cacheKey,
      country_code: countryCode,
      region_code: null,
      granularity: "country_today",
      payload: response,
      fetched_at: nowIso,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }, { onConflict: "cache_key" });

    return json(response);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return json({ error: "Internal error", detail }, 500);
  }
});

