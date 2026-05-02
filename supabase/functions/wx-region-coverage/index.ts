// 修改說明：提供 region_code 覆蓋率與同步健康狀態查詢
// 影響文件：supabase/functions/wx-region-coverage/index.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

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

function createAdminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRole) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, serviceRole, { auth: { persistSession: false } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  try {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

    const url = new URL(req.url);
    const countryCode = (url.searchParams.get("country_code") ?? "").trim().toUpperCase();
    const supabase = createAdminClient();

    let regionQuery = supabase
      .from("wx_region_codes")
      .select("country_code,region_code,region_name,geohash,place_id,updated_at");
    if (countryCode) regionQuery = regionQuery.eq("country_code", countryCode);
    const { data: regions, error: regionErr } = await regionQuery.limit(10000);
    if (regionErr) throw regionErr;

    const countryMap = new Map<string, {
      country_code: string;
      region_count: number;
      seed_count: number;
      location_count: number;
      hotspot_count: number;
      other_count: number;
      latest_updated_at: string | null;
      sample_regions: Array<{ region_code: string; region_name: string; geohash: string }>;
    }>();

    for (const r of regions ?? []) {
      const cc = String(r.country_code ?? "").toUpperCase();
      if (!cc) continue;
      if (!countryMap.has(cc)) {
        countryMap.set(cc, {
          country_code: cc,
          region_count: 0,
          seed_count: 0,
          location_count: 0,
          hotspot_count: 0,
          other_count: 0,
          latest_updated_at: null,
          sample_regions: [],
        });
      }
      const row = countryMap.get(cc)!;
      row.region_count++;
      const placeId = String(r.place_id ?? "");
      if (placeId.startsWith("seed:")) row.seed_count++;
      else if (placeId.startsWith("hotspot:")) row.hotspot_count++;
      else if (placeId.startsWith("loc:") || placeId.startsWith("open_meteo:")) row.location_count++;
      else row.other_count++;
      const updatedAt = typeof r.updated_at === "string" ? r.updated_at : null;
      if (updatedAt && (!row.latest_updated_at || updatedAt > row.latest_updated_at)) row.latest_updated_at = updatedAt;
      if (row.sample_regions.length < 5) {
        row.sample_regions.push({
          region_code: String(r.region_code ?? ""),
          region_name: String(r.region_name ?? ""),
          geohash: String(r.geohash ?? ""),
        });
      }
    }

    let locationQuery = supabase
      .from("wx_locations")
      .select("country_code,geohash")
      .not("country_code", "is", null);
    if (countryCode) locationQuery = locationQuery.eq("country_code", countryCode);
    const { data: locations, error: locationErr } = await locationQuery.limit(10000);
    if (locationErr) throw locationErr;

    const locationCountries = new Map<string, number>();
    for (const l of locations ?? []) {
      const cc = String(l.country_code ?? "").toUpperCase();
      if (!cc) continue;
      locationCountries.set(cc, (locationCountries.get(cc) ?? 0) + 1);
    }

    const byCountry = Array.from(countryMap.values())
      .map((c) => {
        const sourceLocationCount = locationCountries.get(c.country_code) ?? 0;
        return {
          ...c,
          source_location_count: sourceLocationCount,
          coverage_ratio: sourceLocationCount > 0 ? c.region_count / sourceLocationCount : null,
        };
      })
      .sort((a, b) => b.region_count - a.region_count || a.country_code.localeCompare(b.country_code));

    const lastSync = byCountry
      .map((c) => c.latest_updated_at)
      .filter((v): v is string => Boolean(v))
      .sort()
      .at(-1) ?? null;

    return json({
      meta: {
        fetched_at: new Date().toISOString(),
        country_code: countryCode || null,
        country_count: byCountry.length,
        total_region_count: byCountry.reduce((sum, c) => sum + c.region_count, 0),
        total_seed_count: byCountry.reduce((sum, c) => sum + c.seed_count, 0),
        total_hotspot_count: byCountry.reduce((sum, c) => sum + c.hotspot_count, 0),
        total_source_location_count: Array.from(locationCountries.values()).reduce((sum, n) => sum + n, 0),
        latest_region_updated_at: lastSync,
      },
      countries: byCountry,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return json({ error: "Internal error", detail }, 500);
  }
});

