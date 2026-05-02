// 修改說明：提供 /wx/geo/forward（Open‑Meteo Geocoding）把地名/國家限制解析成精準座標與行政區資訊
// 影響文件：supabase/functions/wx-geo-forward/index.ts

import { encodeGeohash } from "../_shared/wx/geohash.ts";
import { jsonError, jsonResponse } from "../_shared/wx/http.ts";
import { getSupabaseAdminClient } from "../_shared/wx/supabase.ts";
import { clampInt } from "../_shared/wx/validate.ts";

type OpenMeteoForwardResult = {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  elevation?: number;
  feature_code?: string;
  country_code?: string;
  admin1?: string;
  admin2?: string;
  admin3?: string;
  admin4?: string;
  locality?: string;
  timezone?: string;
  population?: number;
};

type OpenMeteoForwardResponse = {
  results?: OpenMeteoForwardResult[];
};

function normalizeCountryCode(v: string | null): string | null {
  if (v == null) return null;
  const s = v.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) return null;
  return s;
}

function asNumber(v: unknown): number | null {
  if (typeof v !== "number") return null;
  if (!Number.isFinite(v)) return null;
  return v;
}

function validateLatLon(lat: number, lon: number) {
  if (lat < -90 || lat > 90) throw new Error("Invalid lat");
  if (lon < -180 || lon > 180) throw new Error("Invalid lon");
}

function normalizeToken(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[\s，,、]+/g, " ")
    .replace(/[省市區区縣县鎮镇鄉乡街道]+$/g, "")
    .replace(/\s+/g, " ");
}

function mapKnownRegionTokenToEnglish(token: string): string[] {
  // 針對常見繁中/簡中輸入做最小可用對照，避免一開始就引入大型字典/外部依賴。
  // 這裡回傳多個候選字串，用於 contains match。
  const t = normalizeToken(token);
  const m: Record<string, string[]> = {
    "香港": ["hong kong", "hk"],
    "天水圍": ["tin shui wai"],
    "元朗": ["yuen long"],
    "澳門": ["macau", "macao", "mo"],
    "廣東": ["guangdong"],
    "广东": ["guangdong"],
    "深圳": ["shenzhen"],
    "寶安": ["baoan", "bao'an", "bao an"],
    "宝安": ["baoan", "bao'an", "bao an"],
  };
  return m[t] ?? [t];
}

function inferCountryCodeFromPath(parts: string[], explicit: string | null): string | null {
  if (explicit) return explicit;
  const tokens = parts.map(normalizeToken);
  if (tokens.some((p) => p === "香港")) return "HK";
  if (tokens.some((p) => p === "澳門" || p === "澳门")) return "MO";
  // 中國省市輸入：預設 CN
  if (tokens.some((p) => p === "廣東" || p === "广东" || p === "深圳" || p === "寶安" || p === "宝安")) return "CN";
  return null;
}

function fieldMatchesAny(field: string | null, wants: string[]): boolean {
  if (!field) return false;
  const f = normalizeToken(field);
  return wants.some((w) => f.includes(normalizeToken(w)));
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) return jsonResponse({ error: "Missing query param: q" }, 400);

    const limit = clampInt(Number(url.searchParams.get("limit") ?? 10), 1, 50, "limit");
    const language = (url.searchParams.get("language") ?? "").trim() || null;
    const countryCodeExplicit = normalizeCountryCode(url.searchParams.get("country_code"));

    // 支援「香港/天水圍」「廣東/深圳/寶安」等路徑輸入：
    // - 以最後一段當 upstream name
    // - 以前置段作為過濾條件（admin1/admin2/admin3/locality/name contains）
    const pathParts = q.split("/").map((s) => s.trim()).filter(Boolean);
    const nameQuery = pathParts.length > 1 ? pathParts[pathParts.length - 1] : q;
    const hints = pathParts.length > 1 ? pathParts.slice(0, -1) : [];
    const countryCode = inferCountryCodeFromPath(pathParts, countryCodeExplicit);

    const upstream = new URL("https://geocoding-api.open-meteo.com/v1/search");
    upstream.searchParams.set("name", nameQuery);
    upstream.searchParams.set("count", String(limit));
    if (language) upstream.searchParams.set("language", language);
    if (countryCode) upstream.searchParams.set("country", countryCode);

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
    const data = (await res.json()) as OpenMeteoForwardResponse;
    const results = data.results ?? [];

    const out = results.map((r) => {
      const lat = asNumber(r.latitude);
      const lon = asNumber(r.longitude);
      if (lat == null || lon == null) throw new Error("Upstream returned invalid coordinates");
      validateLatLon(lat, lon);
      const timezone = (r.timezone ?? "UTC").trim() || "UTC";
      const geohash = encodeGeohash(lat, lon, 6);
      return {
        place_id: `open_meteo:${r.id}`,
        name: r.name,
        lat,
        lon,
        geohash,
        timezone,
        country_code: r.country_code ?? null,
        admin1: r.admin1 ?? null,
        admin2: r.admin2 ?? null,
        admin3: r.admin3 ?? null,
        admin4: r.admin4 ?? null,
        locality: r.locality ?? null,
        feature_code: r.feature_code ?? null,
        population: r.population ?? null,
      };
    });

    const filtered = hints.length === 0
      ? out
      : out.filter((p) => {
        // 逐段 hints 做弱匹配：任何一段只要命中 admin1/admin2/admin3/locality/name 其一即可算通過。
        // 這樣像「廣東/深圳/寶安」能命中 admin1=Guangdong, admin2=Shenzhen, name=Bao'an。
        return hints.every((h) => {
          const wants = mapKnownRegionTokenToEnglish(h);
          return (
            fieldMatchesAny(p.country_code, wants) ||
            fieldMatchesAny(p.admin1, wants) ||
            fieldMatchesAny(p.admin2, wants) ||
            fieldMatchesAny(p.admin3, wants) ||
            fieldMatchesAny(p.locality, wants) ||
            fieldMatchesAny(p.name, wants)
          );
        });
      });

    // 寫入 wx_locations：提升後續 place_id 查詢一致性（以 place_id 作唯一鍵）
    if (filtered.length) {
      const supabase = getSupabaseAdminClient();
      const rows = filtered.map((p) => ({
        place_id: p.place_id,
        lat: p.lat,
        lon: p.lon,
        geohash: p.geohash,
        timezone: p.timezone,
        country_code: p.country_code,
        admin1: p.admin1,
        admin2: p.admin2,
        admin3: p.admin3,
        admin4: p.admin4,
        locality: p.locality,
        name: p.name,
        updated_at: new Date().toISOString(),
      }));

      const { error } = await supabase.from("wx_locations").upsert(rows, { onConflict: "place_id" });
      if (error) throw error;
    }

    return jsonResponse({
      meta: {
        q,
        name_query: nameQuery,
        path_hints: hints,
        limit,
        language,
        country_code: countryCode,
        upstream_latency_ms: latencyMs,
      },
      places: filtered,
    });
  } catch (e) {
    return jsonError(e);
  }
});

