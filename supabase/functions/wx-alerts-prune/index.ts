// 修改說明：清理已過期太久的 wx_alerts，避免官方警報長期累積造成資料膨脹
// 影響文件：supabase/functions/wx-alerts-prune/index.ts

import { jsonError, jsonResponse } from "../_shared/wx/http.ts";
import { clampInt } from "../_shared/wx/validate.ts";
import { getSupabaseAdminClient } from "../_shared/wx/supabase.ts";

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

    const supabase = getSupabaseAdminClient();
    const body = await req.json().catch(() => ({} as any));

    // Default: prune alerts that ended > 30 days ago.
    const keepDays = clampInt(Number(body.keep_days ?? 30), 7, 365, "keep_days");
    const cutoff = new Date(Date.now() - keepDays * 86400_000).toISOString();

    // We prune based on ends_at if present; if ends_at is null (unknown), we keep.
    const { error } = await supabase.from("wx_alerts").delete().lt("ends_at", cutoff);
    if (error) throw error;

    return jsonResponse({ ok: true, keep_days: keepDays, cutoff_ends_at_lt: cutoff });
  } catch (e) {
    return jsonError(e);
  }
});

