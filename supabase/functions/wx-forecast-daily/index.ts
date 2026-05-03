// 修改說明：提供 /wx/forecast/daily 對外 API（快取 + 多供應商備援 + 寫入時間序列）
// 影響文件：supabase/functions/wx-forecast-daily/index.ts

import { jsonError, jsonResponse } from "../_shared/wx/http.ts";
import { fetchForecastWithProvider, defaultProviderPriority } from "../_shared/wx/provider_chain.ts";
import { buildCacheKey, recordIngestRun, tryReadCache, upsertDailySeries, writeCache } from "../_shared/wx/storage.ts";
import type { WxDailyForecastResponse, WxProvider } from "../_shared/wx/types.ts";
import { clampInt } from "../_shared/wx/validate.ts";
import { getSupabaseAdminClient } from "../_shared/wx/supabase.ts";
import { resolveLocationFromRequest } from "../_shared/wx/location.ts";

Deno.serve(async (req) => {
  try {
    if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
    const url = new URL(req.url);
    const supabase = getSupabaseAdminClient();
    const loc = await resolveLocationFromRequest({ url, supabase, geohashPrecision: 6 });

    const daysParam = url.searchParams.get("days");
    const days = clampInt(daysParam == null ? 14 : Number(daysParam), 1, 16, "days");

    const provider = (url.searchParams.get("provider") ?? "auto") as WxProvider;
    const allowLiveFetch = url.searchParams.get("allow_live_fetch") !== "false";
    const geohash = loc.geohash;
    const endpoint = "/wx/forecast/daily";
    const cacheKey = buildCacheKey({
      geohash,
      endpoint,
      params: { days, provider },
    });

    const cached = await tryReadCache(supabase, cacheKey);
    if (cached?.isFresh) return jsonResponse(cached.payload);

    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(today.getUTCDate()).padStart(2, "0");
    const todayDate = `${yyyy}-${mm}-${dd}`;
    let dbQuery = supabase
      .from("wx_daily_series")
      .select("date,t_min_c,t_max_c,precip_sum_mm,precip_prob_max,wind_max_ms,uv_max,provider,fetched_at,confidence")
      .eq("geohash", geohash)
      .gte("date", todayDate)
      .order("date", { ascending: true })
      .limit(days);
    if (provider !== "auto") dbQuery = dbQuery.eq("provider", provider);
    const { data: storedRows, error: storedErr } = await dbQuery;
    if (storedErr) throw storedErr;

    if ((storedRows ?? []).length > 0) {
      const first = storedRows![0];
      const response: WxDailyForecastResponse = {
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
          days,
        },
        daily: storedRows as any,
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
          hours: 72,
          days,
        });

        const response: WxDailyForecastResponse = {
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
            days,
          },
          daily: r.daily.slice(0, days),
        };

        await upsertDailySeries(supabase, {
          geohash,
          provider: p,
          points: response.daily,
          // WeatherAPI returns local date strings; all other providers emit UTC dates.
          date_tz: p === "weatherapi" ? (r.timezone ?? "UTC") : "UTC",
        });

        await writeCache(supabase, {
          cache_key: cacheKey,
          geohash,
          endpoint,
          params: { days, provider },
          payload: response,
          ttlSeconds: 6 * 60 * 60,
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

