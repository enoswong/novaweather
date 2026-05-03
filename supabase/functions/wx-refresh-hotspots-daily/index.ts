// 修改說明：排程任務：刷新 wx_hotspots 的 14d daily forecast（寫入序列 + 快取）
// 影響文件：supabase/functions/wx-refresh-hotspots-daily/index.ts

import { encodeGeohash } from "../_shared/wx/geohash.ts";
import { jsonError, jsonResponse } from "../_shared/wx/http.ts";
import { defaultProviderPriority, fetchForecastWithProvider } from "../_shared/wx/provider_chain.ts";
import { buildCacheKey, recordIngestRun, upsertDailySeries, writeCache } from "../_shared/wx/storage.ts";
import { getSupabaseAdminClient } from "../_shared/wx/supabase.ts";
import type { WxDailyForecastResponse } from "../_shared/wx/types.ts";

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
    const supabase = getSupabaseAdminClient();

    const { data: hotspots, error } = await supabase
      .from("wx_hotspots")
      .select("geohash,lat,lon,priority")
      .order("priority", { ascending: false })
      .limit(200);
    if (error) throw error;

    const chain = defaultProviderPriority();
    const endpoint = "/wx/forecast/daily";

    let refreshed = 0;
    for (const hs of hotspots ?? []) {
      const lat = hs.lat;
      const lon = hs.lon;
      const geohash = hs.geohash || encodeGeohash(lat, lon, 6);

      let ok = false;
      for (const p of chain) {
        try {
          const r = await fetchForecastWithProvider({
            provider: p,
            lat,
            lon,
            hours: 72,
            days: 14,
          });

          const response: WxDailyForecastResponse = {
            meta: {
              provider: p,
              fetched_at: r.fetched_at,
              timezone: r.timezone,
              lat,
              lon,
              geohash,
              days: 14,
            },
            daily: r.daily.slice(0, 14),
          };

          await upsertDailySeries(supabase, {
            geohash,
            provider: p,
            points: response.daily,
            // WeatherAPI returns local date strings; all other providers emit UTC dates.
            date_tz: p === "weatherapi" ? (r.timezone ?? "UTC") : "UTC",
          });

          const cacheKey = buildCacheKey({
            geohash,
            endpoint,
            params: { days: 14, provider: "auto" },
          });

          await writeCache(supabase, {
            cache_key: cacheKey,
            geohash,
            endpoint,
            params: { days: 14, provider: "auto" },
            payload: response,
            ttlSeconds: 6 * 60 * 60,
            fetched_at: r.fetched_at,
          });

          await recordIngestRun(supabase, {
            provider: p,
            geohash,
            endpoint: "cron_refresh_hotspots_daily",
            status: "ok",
            latency_ms: r.source_latency_ms,
            http_status: null,
            error: null,
          });

          await supabase
            .from("wx_hotspots")
            .update({ last_refresh_daily_at: new Date().toISOString() })
            .eq("geohash", geohash);

          refreshed++;
          ok = true;
          break;
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          await recordIngestRun(supabase, {
            provider: p,
            geohash,
            endpoint: "cron_refresh_hotspots_daily",
            status: "error",
            latency_ms: null,
            http_status: null,
            error: err.message,
          });
        }
      }

      if (!ok) continue;
    }

    return jsonResponse({ ok: true, refreshed });
  } catch (e) {
    return jsonError(e);
  }
});

