// wx-webhook-worker: 從 wx_webhook_queue 取出並發送 webhook（異步解耦第二步）
// 每分鐘由 pg_cron 觸發，透過 wx_claim_webhook_queue RPC 原子性取出 ≤50 筆，
// 並行發送 HTTP POST 到各訂閱 callback_url，更新狀態為 done/failed。
// 單次執行最多處理 50 筆，遠低於 30s 限制（8s timeout × 50 並行 ≈ 8s 總計）。

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-client-info,apikey",
};

const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5; // 超過 5 次 attempt 的任務標記為永久失敗

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

async function dbRpc<T = unknown>(fn: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`RPC ${fn}: ${res.status} ${await res.text().catch(() => "")}`);
  return res.json() as T;
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
  if (!res.ok) console.warn(`DB POST ${path}: ${res.status}`);
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

// 連續失敗超過此次數時自動停用訂閱
const FAILURE_DEACTIVATE_THRESHOLD = 10;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET" && req.method !== "POST")
    return json({ error: "GET or POST required" }, 405);

  try {
    // 1. 原子性認領一批待發送任務
    type QueueItem = {
      id: string;
      subscription_id: string;
      payload: Record<string, unknown>;
      attempts: number;
    };

    const claimed = await dbRpc<QueueItem[]>("wx_claim_webhook_queue", {
      batch_size: BATCH_SIZE,
    });

    if (!claimed || claimed.length === 0) {
      return json({ ok: true, dispatched: 0, message: "Queue empty" });
    }

    // 2. 批量取得所有相關訂閱（避免 N+1 查詢）
    const subIds = [...new Set(claimed.map(c => c.subscription_id))];
    const subsRaw = await dbGet<Record<string, unknown>[]>(
      `/rest/v1/wx_webhook_subscriptions?id=in.(${subIds.join(",")})&select=id,callback_url,secret,active,failure_count,fire_count&limit=${subIds.length}`
    );
    const subsMap = new Map<string, Record<string, unknown>>(
      subsRaw.map(s => [String(s.id), s])
    );

    // 3. 並行發送
    let dispatched = 0;
    let permanentFailed = 0;

    await Promise.allSettled(claimed.map(async (item) => {
      const sub = subsMap.get(item.subscription_id);
      const doneAt = new Date().toISOString();

      // 超過最大嘗試次數 → 標記為永久失敗，不再重試
      if (item.attempts > MAX_ATTEMPTS) {
        await dbPatch(
          `/rest/v1/wx_webhook_queue?id=eq.${item.id}`,
          { status: "failed", done_at: doneAt, last_error: "Max attempts exceeded" }
        );
        permanentFailed++;
        return;
      }

      if (!sub || !sub.active) {
        // 訂閱已被停用 → 直接標記 done（不發送）
        await dbPatch(
          `/rest/v1/wx_webhook_queue?id=eq.${item.id}`,
          { status: "done", done_at: doneAt }
        );
        return;
      }

      const payloadStr = JSON.stringify(item.payload);
      const headers: Record<string, string> = { "Content-Type": "application/json" };

      if (sub.secret) {
        try {
          const sig = await hmacSha256Hex(sub.secret as string, payloadStr);
          headers["X-WxHook-Signature"] = `sha256=${sig}`;
        } catch { /* 簽名失敗不阻止發送 */ }
      }

      const t0 = Date.now();
      let statusCode: number | null = null;
      let success = false;
      let lastError: string | null = null;

      try {
        const r = await fetch(sub.callback_url as string, {
          method: "POST",
          headers,
          body: payloadStr,
          signal: AbortSignal.timeout(8000),
        });
        statusCode = r.status;
        success = r.status >= 200 && r.status < 300;
        if (!success) lastError = `HTTP ${r.status}`;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        console.warn(`Delivery failed for queue item ${item.id}:`, lastError);
      }

      const duration_ms = Date.now() - t0;

      // 更新 queue 狀態
      const newStatus = success ? "done" : (item.attempts >= MAX_ATTEMPTS ? "failed" : "pending");
      const queuePatch: Record<string, unknown> = {
        status: newStatus,
        done_at: newStatus !== "pending" ? doneAt : undefined,
        last_error: lastError,
      };
      // 若失敗且未超過上限，重新入列（下次 worker 會再試）
      if (!success && newStatus === "pending") {
        // 指數退避：attempts 次嘗試後等待 attempts 分鐘
        const retryAt = new Date(Date.now() + item.attempts * 60_000).toISOString();
        queuePatch.scheduled_at = retryAt;
        queuePatch.status = "pending";
        queuePatch.claimed_at = null;
      }

      await dbPatch(`/rest/v1/wx_webhook_queue?id=eq.${item.id}`, queuePatch);

      // 記錄投遞日誌
      await dbPost("/rest/v1/wx_webhook_deliveries", {
        subscription_id: item.subscription_id,
        event_type: "webhook_queue",
        payload: item.payload,
        status_code: statusCode,
        success,
        attempted_at: new Date(t0).toISOString(),
        duration_ms,
      });

      // 更新訂閱統計
      const newFailures = success
        ? (sub.failure_count as number ?? 0)
        : (sub.failure_count as number ?? 0) + 1;
      const subPatch: Record<string, unknown> = {
        last_fired_at: doneAt,
        fire_count: (sub.fire_count as number ?? 0) + (success ? 1 : 0),
        failure_count: newFailures,
      };
      if (newFailures >= FAILURE_DEACTIVATE_THRESHOLD) {
        subPatch.active = false;
        console.warn(`Auto-deactivating sub ${item.subscription_id} after ${newFailures} failures`);
      }
      await dbPatch(`/rest/v1/wx_webhook_subscriptions?id=eq.${item.subscription_id}`, subPatch);

      if (success) dispatched++;
    }));

    return json({
      ok: true,
      claimed: claimed.length,
      dispatched,
      permanent_failed: permanentFailed,
      fired_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("wx-webhook-worker error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});
