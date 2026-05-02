// 修改說明：排程任務：修剪時間序列舊資料（observed 與 forecast 分開保留）
// 影響文件：supabase/functions/wx-prune-time-series/index.ts

import { jsonError, jsonResponse } from "../_shared/wx/http.ts";
import { getSupabaseAdminClient } from "../_shared/wx/supabase.ts";

type PruneRequest = {
  keep_observed_days?: number; // default 365
  keep_forecast_days?: number; // default 16
};

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
    const supabase = getSupabaseAdminClient();
    const body = (await req.json().catch(() => ({}))) as PruneRequest;

    const keepObservedDays = Math.max(30, Math.min(3650, body.keep_observed_days ?? 365));
    const keepForecastDays = Math.max(7, Math.min(60, body.keep_forecast_days ?? 16));

    const now = Date.now();
    const observedCutoff = new Date(now - keepObservedDays * 24 * 3600 * 1000).toISOString();
    const forecastCutoff = new Date(now - keepForecastDays * 24 * 3600 * 1000).toISOString();
    const dailyCutoffDate = new Date(now - keepObservedDays * 24 * 3600 * 1000);
    const yyyy = dailyCutoffDate.getUTCFullYear();
    const mm = String(dailyCutoffDate.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dailyCutoffDate.getUTCDate()).padStart(2, "0");
    const dailyCutoff = `${yyyy}-${mm}-${dd}`;

    // observed：刪除太舊的 observed
    const { error: e1 } = await supabase
      .from("wx_hourly_series")
      .delete()
      .eq("kind", "observed")
      .lt("valid_time", observedCutoff);
    if (e1) throw e1;

    // forecast：刪除太舊（理論上 forecast 只會在未來；這裡用保留策略避免異常累積）
    const { error: e2 } = await supabase
      .from("wx_hourly_series")
      .delete()
      .eq("kind", "forecast")
      .lt("valid_time", forecastCutoff);
    if (e2) throw e2;

    // daily：刪除太舊的 daily（同 observedCutoff）
    const { error: e3 } = await supabase
      .from("wx_daily_series")
      .delete()
      .lt("date", dailyCutoff);
    if (e3) throw e3;

    return jsonResponse({
      ok: true,
      keep_observed_days: keepObservedDays,
      keep_forecast_days: keepForecastDays,
    });
  } catch (e) {
    return jsonError(e);
  }
});

