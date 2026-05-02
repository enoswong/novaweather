// 修改說明：排程任務：同步 region_code 映射（來源：wx_locations + wx_hotspots 反查 + 種子資料）
// 影響文件：supabase/functions/wx-sync-region-codes/index.ts

import { jsonError, jsonResponse } from "../_shared/wx/http.ts";
import { ensureSeedRegionCodes, syncRegionCodesFromHotspots, syncRegionCodesFromLocations } from "../_shared/wx/region_codes.ts";
import { getSupabaseAdminClient } from "../_shared/wx/supabase.ts";

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
    const supabase = getSupabaseAdminClient();

    let hotspot_limit: number | undefined;
    let hotspot_concurrency: number | undefined;
    const rawBody = await req.text();
    if (rawBody.trim().length > 0) {
      try {
        const body = JSON.parse(rawBody) as Record<string, unknown>;
        const hl = Number(body.hotspot_limit);
        const hc = Number(body.hotspot_concurrency);
        if (Number.isFinite(hl)) hotspot_limit = hl;
        if (Number.isFinite(hc)) hotspot_concurrency = hc;
      } catch {
        // ignore invalid JSON; cron POST 常為空 body
      }
    }

    const fromLocations = await syncRegionCodesFromLocations(supabase);
    const hotspotSync = await syncRegionCodesFromHotspots({
      supabase,
      limit: hotspot_limit,
      concurrency: hotspot_concurrency,
    });
    const seeded = await ensureSeedRegionCodes(supabase);

    const { data: summary, error } = await supabase
      .from("wx_region_codes")
      .select("country_code")
      .limit(5000);
    if (error) throw error;
    const countries = new Set<string>();
    for (const row of summary ?? []) countries.add(String(row.country_code ?? "").toUpperCase());

    return jsonResponse({
      ok: true,
      synced_from_locations: fromLocations,
      hotspot_sync: hotspotSync,
      seeded,
      country_count: countries.size,
      countries: Array.from(countries).sort(),
      synced_at: new Date().toISOString(),
    });
  } catch (e) {
    return jsonError(e);
  }
});

