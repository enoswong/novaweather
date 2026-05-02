// 修改說明：排程任務：清理 wx_cache 過期資料
// 影響文件：supabase/functions/wx-cleanup-expired-cache/index.ts

import { jsonError, jsonResponse } from "../_shared/wx/http.ts";
import { getSupabaseAdminClient } from "../_shared/wx/supabase.ts";

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
    const supabase = getSupabaseAdminClient();

    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .from("wx_cache")
      .delete()
      .lt("expires_at", nowIso);
    if (error) throw error;

    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
});

