// wx-webhook-dispatch: cron-driven webhook delivery
// Runs every 5 minutes via pg_cron → net.http_post.
// Fetches alerts ingested in the past ~6 minutes and POSTs to matching subscribers.
// GET  /wx-webhook-dispatch?since_minutes=6  (manual trigger or cron)
// POST /wx-webhook-dispatch                  (cron POST)

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

async function dbPost(path: string, body: unknown) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) console.warn(`DB POST ${path}: ${res.status}`); // best-effort
}

async function dbPatch(path: string, body: unknown) {
  await fetch(`${SUPABASE_URL}${path}`, {
    method: "PATCH",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
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

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Auto-deactivate subscriptions with ≥10 consecutive failures
const FAILURE_DEACTIVATE_THRESHOLD = 10;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET" && req.method !== "POST")
    return json({ error: "GET or POST required" }, 405);

  const url = new URL(req.url);
  const sinceMinutes = Math.min(parseInt(url.searchParams.get("since_minutes") ?? "6"), 60);
  const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString();

  try {
    // 1. Fetch all active subscriptions
    const subs = await dbGet<Record<string, unknown>[]>(
      "/rest/v1/wx_webhook_subscriptions?active=eq.true&select=*&limit=200"
    );
    if (!subs.length) return json({ ok: true, dispatched: 0, message: "No active subscriptions" });

    // 2. Fetch new alerts (for subscriptions that want alert_new events)
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

    // 3. Dispatch concurrently, one promise per subscription
    let dispatched = 0;

    await Promise.allSettled(subs.map(async (sub) => {
      const eventTypes = (sub.event_types as string[]) ?? [];
      const events: unknown[] = [];

      // alert_new events
      if (eventTypes.includes("alert_new") && newAlerts.length > 0) {
        let matching = newAlerts;
        const subLat = sub.lat as number | null;
        const subLon = sub.lon as number | null;
        if (subLat != null && subLon != null) {
          matching = newAlerts.filter(a => {
            const aLat = a.centroid_lat as number | null;
            const aLon = a.centroid_lon as number | null;
            if (aLat == null || aLon == null) return true; // no centroid = global broadcast
            return haversineKm(subLat, subLon, aLat, aLon) <= ((sub.radius_km as number) ?? 50);
          });
        }
        for (const alert of matching) {
          events.push({ event_type: "alert_new", data: alert });
        }
      }

      if (events.length === 0) return;

      const payload = {
        subscription_id: sub.id,
        api_version: "v1",
        events,
        fired_at: new Date().toISOString(),
      };
      const payloadStr = JSON.stringify(payload);

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (sub.secret) {
        try {
          const sig = await hmacSha256Hex(sub.secret as string, payloadStr);
          headers["X-WxHook-Signature"] = `sha256=${sig}`;
        } catch { /* skip signing on error */ }
      }

      const t0 = Date.now();
      let statusCode: number | null = null;
      let success = false;
      try {
        const r = await fetch(sub.callback_url as string, {
          method: "POST",
          headers,
          body: payloadStr,
          signal: AbortSignal.timeout(8000),
        });
        statusCode = r.status;
        success = r.status >= 200 && r.status < 300;
      } catch (e) {
        console.warn(`Delivery failed for sub ${sub.id}:`, e);
      }
      const duration_ms = Date.now() - t0;

      // Log delivery (best-effort, non-blocking)
      await dbPost("/rest/v1/wx_webhook_deliveries", {
        subscription_id: sub.id,
        event_type: events.map((e: unknown) => (e as Record<string, string>).event_type).join("+"),
        payload,
        status_code: statusCode,
        success,
        attempted_at: new Date().toISOString(),
        duration_ms,
      });

      // Update subscription stats
      const newFailures = success ? (sub.failure_count as number ?? 0) : (sub.failure_count as number ?? 0) + 1;
      const patch: Record<string, unknown> = {
        last_fired_at: new Date().toISOString(),
        fire_count:    (sub.fire_count as number ?? 0) + 1,
        failure_count: newFailures,
      };
      // Auto-deactivate after threshold consecutive failures
      if (newFailures >= FAILURE_DEACTIVATE_THRESHOLD) {
        patch.active = false;
        console.warn(`Auto-deactivating sub ${sub.id} after ${newFailures} failures`);
      }
      await dbPatch(`/rest/v1/wx_webhook_subscriptions?id=eq.${sub.id}`, patch);

      dispatched++;
    }));

    return json({
      ok: true,
      dispatched,
      checked_subscriptions: subs.length,
      new_alerts_found: newAlerts.length,
      window_minutes: sinceMinutes,
      since,
      fired_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("wx-webhook-dispatch error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});
