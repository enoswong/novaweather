// 修改說明：新增 CORS 代理 function，供 API 實測頁跨網域轉發 /wx* 端點
// 影響文件：supabase/functions/wx-api-proxy/index.ts

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-client-info,apikey",
  "access-control-max-age": "86400",
};

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
  // maintenance
  "wx-provider-health-refresh",
  "wx-cleanup-expired-cache",
  "wx-prune-time-series",
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
    const requestUrl = new URL(req.url);
    const fn = (requestUrl.searchParams.get("fn") ?? "").trim();
    if (!fn || !ALLOWED_FUNCTIONS.has(fn)) {
      return json({ error: "Invalid fn parameter" }, 400);
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

