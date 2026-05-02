// 修改說明：提供 /wx/geo/reverse（Open‑Meteo Reverse Geocoding）把座標反查成國家/地區/城市資訊
// 影響文件：supabase/functions/wx-geo-reverse/index.ts

import { encodeGeohash } from "../_shared/wx/geohash.ts";
import { jsonError, jsonResponse } from "../_shared/wx/http.ts";
import { getSupabaseAdminClient } from "../_shared/wx/supabase.ts";
import { parseNumber } from "../_shared/wx/validate.ts";

type OpenMeteoReverseResult = {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  feature_code?: string;
  country_code?: string;
  admin1?: string;
  admin2?: string;
  admin3?: string;
  admin4?: string;
  locality?: string;
  timezone?: string;
};

type OpenMeteoReverseResponse = {
  results?: OpenMeteoReverseResult[];
};

function asNumber(v: unknown): number | null {
  if (typeof v !== "number") return null;
  if (!Number.isFinite(v)) return null;
  return v;
}

function validateLatLon(lat: number, lon: number) {
  if (lat < -90 || lat > 90) throw new Error("Invalid lat");
  if (lon < -180 || lon > 180) throw new Error("Invalid lon");
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

    const url = new URL(req.url);
    const lat = parseNumber(url.searchParams.get("lat"), "lat");
    const lon = parseNumber(url.searchParams.get("lon"), "lon");
    validateLatLon(lat, lon);

    const language = (url.searchParams.get("language") ?? "").trim() || null;

    const upstream = new URL("https://geocoding-api.open-meteo.com/v1/reverse");
    upstream.searchParams.set("latitude", String(lat));
    upstream.searchParams.set("longitude", String(lon));
    upstream.searchParams.set("count", "1");
    if (language) upstream.searchParams.set("language", language);

    const started = Date.now();
    const res = await fetch(upstream, {
      headers: { "user-agent": "novaweather-geo/0.2.3" },
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return jsonResponse(
        { error: "Upstream error", upstream_status: res.status },
        502,
      );
    }

    const data = (await res.json()) as OpenMeteoReverseResponse;
    const r = (data.results ?? [])[0] ?? null;
    if (!r) {
      return jsonResponse({ meta: { lat, lon, language, upstream_latency_ms: latencyMs }, place: null });
    }

    const rLat = asNumber(r.latitude);
    const rLon = asNumber(r.longitude);
    if (rLat == null || rLon == null) throw new Error("Upstream returned invalid coordinates");
    validateLatLon(rLat, rLon);

    const timezone = (r.timezone ?? "UTC").trim() || "UTC";
    const geohash = encodeGeohash(rLat, rLon, 6);

    const place = {
      place_id: `open_meteo:${r.id}`,
      name: r.name,
      lat: rLat,
      lon: rLon,
      geohash,
      timezone,
      country_code: r.country_code ?? null,
      admin1: r.admin1 ?? null,
      admin2: r.admin2 ?? null,
      admin3: r.admin3 ?? null,
      admin4: r.admin4 ?? null,
      locality: r.locality ?? null,
      feature_code: r.feature_code ?? null,
    };

    // Upsert to wx_locations for stable place_id lookups.
    const supabase = getSupabaseAdminClient();
    const { error } = await supabase.from("wx_locations").upsert([{
      place_id: place.place_id,
      lat: place.lat,
      lon: place.lon,
      geohash: place.geohash,
      timezone: place.timezone,
      country_code: place.country_code,
      admin1: place.admin1,
      admin2: place.admin2,
      admin3: place.admin3,
      admin4: place.admin4,
      locality: place.locality,
      name: place.name,
      updated_at: new Date().toISOString(),
    }], { onConflict: "place_id" });
    if (error) throw error;

    return jsonResponse({
      meta: { lat, lon, language, upstream_latency_ms: latencyMs },
      place,
    });
  } catch (e) {
    return jsonError(e);
  }
});

