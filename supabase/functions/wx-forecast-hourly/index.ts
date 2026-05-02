// 修改說明：提供 /wx/forecast/hourly 對外 API（快取 + 多供應商備援 + 寫入時間序列）
// 影響文件：supabase/functions/wx-forecast-hourly/index.ts

import { jsonError, jsonResponse } from "../_shared/wx/http.ts";
import { fetchForecastWithProvider, defaultProviderPriority } from "../_shared/wx/provider_chain.ts";
import { buildCacheKey, recordIngestRun, tryReadCache, upsertHourlySeries, writeCache } from "../_shared/wx/storage.ts";
import type { WxHourlyForecastResponse, WxProvider } from "../_shared/wx/types.ts";
import { clampInt } from "../_shared/wx/validate.ts";
import { getSupabaseAdminClient } from "../_shared/wx/supabase.ts";
import { resolveLocationFromRequest } from "../_shared/wx/location.ts";

Deno.serve(async (req) => {
  try {
    if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
    const url = new URL(req.url);
    const supabase = getSupabaseAdminClient();
    const loc = await resolveLocationFromRequest({ url, supabase, geohashPrecision: 6 });

    const hoursParam = url.searchParams.get("hours");
    const hours = clampInt(hoursParam == null ? 72 : Number(hoursParam), 1, 168, "hours");

    const provider = (url.searchParams.get("provider") ?? "auto") as WxProvider;
    const allowLiveFetch = url.searchParams.get("allow_live_fetch") !== "false";
    const geohash = loc.geohash;
    const endpoint = "/wx/forecast/hourly";
    const cacheKey = buildCacheKey({
      geohash,
      endpoint,
      params: { hours, provider },
    });

    const cached = await tryReadCache(supabase, cacheKey);
    if (cached?.isFresh) {
      return jsonResponse(cached.payload);
    }

    const nowIso = new Date().toISOString();
    const endIso = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    let dbQuery = supabase
      .from("wx_hourly_series")
      .select("valid_time,temp_c,feels_like_c,humidity_pct,dewpoint_c,pressure_hpa,wind_ms,wind_dir_deg,gust_ms,precip_mm,precip_prob,snow_mm,cloud_pct,visibility_m,uv_index,provider,fetched_at,confidence")
      .eq("geohash", geohash)
      .eq("kind", "forecast")
      .gte("valid_time", nowIso)
      .lte("valid_time", endIso)
      .order("valid_time", { ascending: true })
      .limit(hours);
    if (provider !== "auto") dbQuery = dbQuery.eq("provider", provider);
    const { data: storedRows, error: storedErr } = await dbQuery;
    if (storedErr) throw storedErr;

    if ((storedRows ?? []).length > 0) {
      const first = storedRows![0];
      const response: WxHourlyForecastResponse = {
        meta: {
          provider: first.provider as Exclude<WxProvider, "auto">,
          fetched_at: first.fetched_at,
          timezone: loc.timezone,
          lat: loc.lat,
          lon: loc.lon,
          geohash,
          place_id: loc.place_id,
          country_code: loc.country_code,
          admin1: loc.admin1,
          admin2: loc.admin2,
          admin3: loc.admin3,
          admin4: loc.admin4,
          locality: loc.locality,
          name: loc.name,
          hours,
        },
        hourly: storedRows as any,
      };
      return jsonResponse(response);
    }

    if (!allowLiveFetch) {
      return jsonResponse({
        error: "No stored forecast available",
        detail: "Cron has not populated this location yet. Retry later or call with allow_live_fetch=true.",
      }, 404);
    }

    const chain = provider === "auto"
      ? defaultProviderPriority()
      : [provider as Exclude<WxProvider, "auto">];

    let lastError: Error | null = null;
    for (const p of chain) {
      try {
        const r = await fetchForecastWithProvider({
          provider: p,
          lat: loc.lat,
          lon: loc.lon,
          hours,
          days: 14,
        });

        const response: WxHourlyForecastResponse = {
          meta: {
            provider: p,
            fetched_at: r.fetched_at,
            timezone: r.timezone ?? loc.timezone,
            lat: loc.lat,
            lon: loc.lon,
            geohash,
            place_id: loc.place_id,
            country_code: loc.country_code,
            admin1: loc.admin1,
            admin2: loc.admin2,
            admin3: loc.admin3,
            admin4: loc.admin4,
            locality: loc.locality,
            name: loc.name,
            hours,
          },
          hourly: r.hourly,
        };

        await upsertHourlySeries(supabase, {
          geohash,
          kind: "forecast",
          provider: p,
          points: r.hourly,
        });

        await writeCache(supabase, {
          cache_key: cacheKey,
          geohash,
          endpoint,
          params: { hours, provider },
          payload: response,
          ttlSeconds: 15 * 60,
          fetched_at: r.fetched_at,
        });

        await recordIngestRun(supabase, {
          provider: p,
          geohash,
          endpoint,
          status: "ok",
          latency_ms: r.source_latency_ms,
          http_status: null,
          error: null,
        });

        return jsonResponse(response);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        await recordIngestRun(supabase, {
          provider: p,
          geohash,
          endpoint,
          status: "error",
          latency_ms: null,
          http_status: null,
          error: lastError.message,
        });
      }
    }

    throw lastError ?? new Error("No provider available");
  } catch (e) {
    return jsonError(e);
  }
});

