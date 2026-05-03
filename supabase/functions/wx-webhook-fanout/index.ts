// wx-webhook-fanout: 寫入 webhook queue（異步解耦第一步）
// 每 5 分鐘由 pg_cron 觸發，掃描新警報並為每個匹配的訂閱寫入 wx_webhook_queue。
// 不進行 HTTP POST，保持此函式在 5 秒內完成；實際發送由 wx-webhook-worker 負責。
//
// 與舊版 wx-webhook-dispatch 的差異：
//   舊版：fanout + HTTP POST，可能超過 30s
//   新版：僅 fanout（DB INSERT），wx-webhook-worker 負責 HTTP POST

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-client-info,apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

async function dbGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`DB GET ${path}: ${res.status}`);
  return res.json() as T;
}

async function dbPost(path: string, body: unknown, prefer = "return=minimal") {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": prefer,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    console.warn(`DB POST ${path}: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return res;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET" && req.method !== "POST")
    return json({ error: "GET or POST required" }, 405);

  const url = new URL(req.url);
  const sinceMinutes = Math.min(parseInt(url.searchParams.get("since_minutes") ?? "6"), 60);
  const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString();

  try {
    // 1. 取得所有啟用中訂閱
    const subs = await dbGet<Record<string, unknown>[]>(
      "/rest/v1/wx_webhook_subscriptions?active=eq.true&select=*&limit=500"
    );
    if (!subs.length) {
      return json({ ok: true, queued: 0, message: "No active subscriptions" });
    }

    // 2. 取得時間窗口內的新警報
    const wantsAlerts = subs.some(s => (s.event_types as string[])?.includes("alert_new"));
    let newAlerts: Record<string, unknown>[] = [];
    if (wantsAlerts) {
      try {
        newAlerts = await dbGet<Record<string, unknown>[]>(
          `/rest/v1/wx_active_alerts` +
          `?ingested_at=gte.${encodeURIComponent(since)}` +
          `&select=id,source,event_type,severity,urgency,headline,effective,expires,centroid_lat,centroid_lon,country_code,region_code` +
          `&limit=100`
        );
      } catch (e) {
        console.warn("Failed to fetch wx_active_alerts:", e);
      }
    }

    if (newAlerts.length === 0) {
      return json({ ok: true, queued: 0, alerts_found: 0 });
    }

    // 3. 對每個訂閱 × 每個匹配警報：寫入 wx_webhook_queue
    //    dedup_key = subscription_id:alert_id，ON CONFLICT DO NOTHING 防止重複
    let queued = 0;
    const firedAt = new Date().toISOString();

    for (const sub of subs) {
      const eventTypes = (sub.event_types as string[]) ?? [];
      if (!eventTypes.includes("alert_new")) continue;

      let matchingAlerts = newAlerts;

      // 地理過濾（若訂閱有指定座標）
      const subLat = sub.lat as number | null;
      const subLon = sub.lon as number | null;
      if (subLat != null && subLon != null) {
        matchingAlerts = newAlerts.filter((a) => {
          const aLat = a.centroid_lat as number | null;
          const aLon = a.centroid_lon as number | null;
          if (aLat == null || aLon == null) return true; // 無 centroid = 全域廣播
          return haversineKm(subLat, subLon, aLat, aLon) <= ((sub.radius_km as number) ?? 50);
        });
      }

      if (matchingAlerts.length === 0) continue;

      // 將此訂閱匹配到的所有警報打包為一個 queue 項目（降低 DB 寫入量）
      const alertEvents = matchingAlerts.map((alert) => ({
        event_type: "alert_new",
        data: alert,
      }));

      const payload = {
        subscription_id: sub.id,
        api_version: "v1",
        events: alertEvents,
        fired_at: firedAt,
      };

      // dedup_key：subscription_id + 所有 alert id 的排序 join（防止同批次重複）
      const alertIds = matchingAlerts
        .map((a) => String(a.id))
        .sort()
        .join(",");
      const dedupKey = `${sub.id}:${alertIds}`;

      await dbPost(
        "/rest/v1/wx_webhook_queue",
        {
          subscription_id: sub.id,
          payload,
          status: "pending",
          dedup_key: dedupKey,
          scheduled_at: firedAt,
        },
        "resolution=ignore-duplicates", // ON CONFLICT (dedup_key) DO NOTHING
      );

      queued++;
    }

    return json({
      ok: true,
      queued,
      alerts_found: newAlerts.length,
      subscriptions_checked: subs.length,
      window_minutes: sinceMinutes,
      since,
      fired_at: firedAt,
    });
  } catch (err) {
    console.error("wx-webhook-fanout error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});
