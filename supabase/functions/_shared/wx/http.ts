// 修改說明：提供 Edge Function 的 JSON 回應與錯誤處理
// 影響文件：supabase/functions/_shared/wx/http.ts

import { HttpError } from "./validate.ts";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function jsonError(err: unknown): Response {
  if (err instanceof HttpError) {
    return jsonResponse({ error: err.message }, err.status);
  }
  const msg = err instanceof Error ? err.message : "Unknown error";
  return jsonResponse({ error: "Internal error", detail: msg }, 500);
}

