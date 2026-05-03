// 修改說明：新增 CORS 代理 function，供 API 實測頁跨網域轉發 /wx* 端點
// 影響文件：supabase/functions/wx-api-proxy/index.ts
// v0.9.1：DELETE 方法限縮為僅允許 wx-webhook-register（避免誤刪其他資源）
// v1.0.0-alpha：加入可選 API Key 驗證（X-WxApi-Key header）；
//               新增 wx-webhook-fanout / wx-webhook-worker 至白名單

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-client-info,apikey,x-wxapi-key",
  "access-control-max-age": "86400",
};

// 只有這些 function 允許 DELETE 方法通過代理
const DELETE_ALLOWED_FNS = new Set([
  "wx-webhook-register",
]);

const ALLOWED_FUNCTIONS = new Set([
  // core
  "wx-country-today",
  "wx-region",
  "wx-region-coverage",
  "wx-sync-region-codes",
  "wx-geo-forward",
  "wx-geo-reverse",
  "wx-forecast-hourly",
  "wx-forecast-daily",
  "wx-observed-now",
  "wx-alerts",
  "wx-risk",
  "wx-environment-timeline",
  // Phase A
  "wx-air-quality",
  "wx-observed-metar",
  "wx-status",
  "wx-alerts-ingest-nws",
  "wx-alerts-ingest-hko",
  "wx-alerts-ingest-smg",
  "wx-alerts-ingest-cap",
  "wx-refresh-airquality-hotspots",
  // Phase C
  "wx-bundle",
  // Phase B
  "wx-marine",
  "wx-solar",
  "wx-historical",
  "wx-astronomy",
  "wx-refresh-marine-hotspots",
  // Phase D
  "wx-indices",
  "wx-compare",
  "wx-anomaly",
  "wx-webhook-register",
  "wx-webhook-dispatch",
  "wx-webhook-fanout",
  "wx-webhook-worker",
  // maintenance / ops
  "wx-provider-health-refresh",
  "wx-cleanup-expired-cache",
  "wx-prune-time-series",
  "wx-status",
]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    // v1.0.0-alpha: 可選 API Key 驗證
    // 若 WX_PUBLIC_API_KEY secret 已設定，所有請求必須帶 X-WxApi-Key header 且值相符。
    // 未設定時跳過驗證（向前相容），方便本地開發。
    const API_KEY = Deno.env.get("WX_PUBLIC_API_KEY");
    if (API_KEY) {
      const clientKey = req.headers.get("x-wxapi-key");
      if (clientKey !== API_KEY) {
        return json({ error: "Unauthorized", hint: "Provide X-WxApi-Key header" }, 401);
      }
    }

    const requestUrl = new URL(req.url);
    const fn = (requestUrl.searchParams.get("fn") ?? "").trim();
    if (!fn || !ALLOWED_FUNCTIONS.has(fn)) {
      return json({ error: "Invalid fn parameter" }, 400);
    }

    // DELETE 方法僅允許特定 function（限縮攻擊面）
    if (req.method === "DELETE" && !DELETE_ALLOWED_FNS.has(fn)) {
      return json({ error: `DELETE not permitted for ${fn}` }, 405);
    }

    const baseUrl = Deno.env.get("SUPABASE_URL");
    if (!baseUrl) return json({ error: "Missing SUPABASE_URL" }, 500);

    const upstreamUrl = new URL(`${baseUrl.replace(/\/$/, "")}/functions/v1/${fn}`);
    for (const [k, v] of requestUrl.searchParams.entries()) {
      if (k === "fn") continue;
      upstreamUrl.searchParams.set(k, v);
    }

    const upstreamHeaders = new Headers();
    const auth = req.headers.get("authorization");
    if (auth) upstreamHeaders.set("authorization", auth);

    const hasBody = req.method === "POST" || req.method === "PUT" || req.method === "PATCH";
    if (hasBody) upstreamHeaders.set("content-type", "application/json");
    const bodyText = hasBody ? await req.text() : undefined;
    const upstreamRes = await fetch(upstreamUrl.toString(), {
      method: req.method,
      headers: upstreamHeaders,
      body: hasBody ? bodyText : undefined,
    });

    const text = await upstreamRes.text();
    return new Response(text, {
      status: upstreamRes.status,
      headers: {
        ...CORS_HEADERS,
        "content-type": upstreamRes.headers.get("content-type") ?? "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return json({ error: "Proxy error", detail }, 500);
  }
});
