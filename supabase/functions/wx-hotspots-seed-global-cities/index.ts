// 修改說明：一次性匯入全球主要城市到 wx_hotspots（讓預取/observed 排程可立即運作）
// 影響文件：supabase/functions/wx-hotspots-seed-global-cities/index.ts

import { encodeGeohash } from "../_shared/wx/geohash.ts";
import { jsonError, jsonResponse } from "../_shared/wx/http.ts";
import { clampInt } from "../_shared/wx/validate.ts";
import { getSupabaseAdminClient } from "../_shared/wx/supabase.ts";

type GeoJsonFeature = {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
};

type GeoJson = {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
};

function asNumber(v: unknown): number | null {
  if (typeof v !== "number") return null;
  if (!Number.isFinite(v)) return null;
  return v;
}

function clampLatLon(lat: number, lon: number): { lat: number; lon: number } | null {
  if (lat < -90 || lat > 90) return null;
  if (lon < -180 || lon > 180) return null;
  return { lat, lon };
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

    const supabase = getSupabaseAdminClient();
    const body = await req.json().catch(() => ({} as any));

    const limit = clampInt(Number(body.limit ?? 300), 50, 2000, "limit");
    const precision = clampInt(Number(body.geohash_precision ?? 6), 5, 7, "geohash_precision");

    const url =
      "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_populated_places_simple.geojson";
    const res = await fetch(url, { headers: { "user-agent": "novaweather-seed/0.2" } });
    if (!res.ok) throw new Error(`Seed dataset HTTP ${res.status}`);
    const data = (await res.json()) as GeoJson;

    const rows: Array<{ geohash: string; lat: number; lon: number; priority: number }> = [];

    for (const f of data.features ?? []) {
      if (f.geometry?.type !== "Point") continue;
      const coords = f.geometry.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const lon = asNumber(coords[0]);
      const lat = asNumber(coords[1]);
      if (lat == null || lon == null) continue;
      const ll = clampLatLon(lat, lon);
      if (!ll) continue;

      // Natural Earth 常用欄位 pop_max（最大人口估計）；不存在時用 0。
      const pop = asNumber(f.properties?.pop_max) ?? asNumber(f.properties?.POP_MAX) ?? 0;
      const geohash = encodeGeohash(ll.lat, ll.lon, precision);
      rows.push({ geohash, lat: ll.lat, lon: ll.lon, priority: Math.round(pop) });
    }

    rows.sort((a, b) => b.priority - a.priority);
    const top = rows.slice(0, limit);

    if (top.length) {
      const { error } = await supabase.from("wx_hotspots").upsert(top, { onConflict: "geohash" });
      if (error) throw error;
    }

    return jsonResponse({
      ok: true,
      inserted: top.length,
      source: "natural_earth",
      limit,
      geohash_precision: precision,
    });
  } catch (e) {
    return jsonError(e);
  }
});

