// wx-webhook-register: manage webhook subscriptions
// POST   /wx-webhook-register  — register a new subscription
// GET    /wx-webhook-register?owner_key=xxx — list own subscriptions
// DELETE /wx-webhook-register?id=xxx&owner_key=xxx — deactivate subscription

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-client-info,apikey",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const VALID_EVENTS      = new Set(["alert_new", "risk_high"]);
const MAX_SUBS_PER_OWNER = 20;

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
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`DB GET ${path}: ${res.status}`);
  return res.json() as T;
}

async function dbPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DB POST ${path}: ${res.status} ${err}`);
  }
  return res.json() as T;
}

async function dbPatch(path: string, body: unknown) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
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
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DB PATCH ${path}: ${res.status} ${err}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  try {
    const url = new URL(req.url);

    // ── POST: register ──────────────────────────────────────────────────────
    if (req.method === "POST") {
      let body: Record<string, unknown>;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

      const { owner_key, callback_url, event_types, lat, lon, radius_km, secret } = body as Record<string, unknown>;

      if (!owner_key || typeof owner_key !== "string") return json({ error: "owner_key required" }, 400);
      if (!callback_url || typeof callback_url !== "string") return json({ error: "callback_url required" }, 400);
      try { new URL(callback_url as string); } catch { return json({ error: "Invalid callback_url" }, 400); }
      if (!(callback_url as string).startsWith("https://"))
        return json({ error: "callback_url must use HTTPS" }, 400);

      const events: string[] = Array.isArray(event_types)
        ? (event_types as unknown[]).filter((e): e is string => typeof e === "string" && VALID_EVENTS.has(e))
        : ["alert_new"];
      if (events.length === 0)
        return json({ error: `No valid event_types. Valid: ${[...VALID_EVENTS].join(", ")}` }, 400);

      // Enforce per-owner limit
      const existing = await dbGet<{ id: string }[]>(
        `/rest/v1/wx_webhook_subscriptions?owner_key=eq.${encodeURIComponent(owner_key as string)}&active=eq.true&select=id`
      );
      if (existing.length >= MAX_SUBS_PER_OWNER)
        return json({ error: `Max ${MAX_SUBS_PER_OWNER} active subscriptions per owner_key` }, 429);

      const record = {
        owner_key,
        callback_url,
        event_types: events,
        lat:       (lat != null && !isNaN(Number(lat))) ? Number(lat) : null,
        lon:       (lon != null && !isNaN(Number(lon))) ? Number(lon) : null,
        radius_km: (radius_km != null && !isNaN(Number(radius_km)))
                   ? Math.min(Math.max(Number(radius_km), 1), 5000) : 50,
        secret:    secret ? String(secret).slice(0, 256) : null,
        active:    true,
      };

      const result = await dbPost<unknown[]>("/rest/v1/wx_webhook_subscriptions", record);
      const sub = Array.isArray(result) ? result[0] : result as Record<string, unknown>;
      // Never return secret or owner_key in response
      const { secret: _s, owner_key: _ok, ...safe } = sub as Record<string, unknown>;
      return json({ ok: true, subscription: safe }, 201);
    }

    // ── GET: list ────────────────────────────────────────────────────────────
    if (req.method === "GET") {
      const owner_key = url.searchParams.get("owner_key");
      if (!owner_key) return json({ error: "owner_key required" }, 400);
      const subs = await dbGet<unknown[]>(
        `/rest/v1/wx_webhook_subscriptions?owner_key=eq.${encodeURIComponent(owner_key)}` +
        `&select=id,callback_url,event_types,lat,lon,radius_km,active,created_at,last_fired_at,fire_count,failure_count` +
        `&order=created_at.desc`
      );
      return json({ subscriptions: subs, count: subs.length });
    }

    // ── DELETE: deactivate ────────────────────────────────────────────────────
    if (req.method === "DELETE") {
      const id        = url.searchParams.get("id");
      const owner_key = url.searchParams.get("owner_key");
      if (!id || !owner_key) return json({ error: "id and owner_key required" }, 400);
      await dbPatch(
        `/rest/v1/wx_webhook_subscriptions?id=eq.${encodeURIComponent(id)}&owner_key=eq.${encodeURIComponent(owner_key)}`,
        { active: false, updated_at: new Date().toISOString() }
      );
      return json({ ok: true, message: "Subscription deactivated" });
    }

    return json({ error: "Method not allowed. Supported: GET, POST, DELETE" }, 405);
  } catch (err) {
    console.error("wx-webhook-register error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});
