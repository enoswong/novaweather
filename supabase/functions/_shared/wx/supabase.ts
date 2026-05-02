// 修改說明：建立 Supabase server client（僅用於 Edge Functions）
// 影響文件：supabase/functions/_shared/wx/supabase.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export function getSupabaseAdminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in function env");
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
}

