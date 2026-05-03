// 修改說明：系統健康狀態 API — 供監控/ops 使用，回傳 DB、供應商、Cron 健康度
// 影響文件：supabase/functions/wx-status/index.ts
// v0.9.1 新增

import { jsonError, jsonResponse } from "../_shared/wx/http.ts";
import { getSupabaseAdminClient } from "../_shared/wx/supabase.ts";

const VERSION = "0.9.1";

// 各 cron 任務的預期最大間隔（秒），用來判斷「上次成功執行是否過期」
const CRON_INGEST_ENDPOINTS: Record<string, number> = {
  // endpoint 名稱（寫入 wx_ingest_runs.endpoint）→ 最大可接受間隔（秒）
  "cron_refresh_hotspots_hourly":  45 * 60,  // */30 + 容差 15min
  "cron_refresh_hotspots_daily":   7 * 3600, // */6h + 容差 1h
  "/wx/observed/now":              30 * 60,  // observed 刷新 */15 + 容差
};

Deno.serve(async (req) => {
  try {
    if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

    const supabase = getSupabaseAdminClient();
    const now = Date.now();
    const ts = new Date(now).toISOString();

    // ── 1. DB 連線狀態（簡單 select 1）────────────────────────
    let dbOk = false;
    let dbError: string | null = null;
    try {
      const { error } = await supabase.from("wx_cache").select("cache_key").limit(1);
      dbOk = !error;
      if (error) dbError = error.message;
    } catch (e) {
      dbError = e instanceof Error ? e.message : String(e);
    }

    // ── 2. 供應商健康（wx_provider_health）───────────────────
    const { data: phRows, error: phErr } = await supabase
      .from("wx_provider_health")
      .select("provider,failure_rate_15m,p95_latency_ms,circuit_open_until,updated_at")
      .order("provider", { ascending: true });

    const providers = (phRows ?? []).map((r: any) => ({
      provider: r.provider,
      failure_rate_15m: r.failure_rate_15m,
      p95_latency_ms: r.p95_latency_ms,
      circuit_open: r.circuit_open_until != null
        && new Date(r.circuit_open_until).getTime() > now,
      circuit_open_until: r.circuit_open_until ?? null,
      updated_at: r.updated_at,
    }));

    // ── 3. Cron 健康：從 wx_ingest_runs 推算各工作最近執行狀況 ──
    const since1h = new Date(now - 3600 * 1000).toISOString();
    const since24h = new Date(now - 24 * 3600 * 1000).toISOString();

    const { data: ingestRows } = await supabase
      .from("wx_ingest_runs")
      .select("endpoint,status,finished_at")
      .gte("finished_at", since24h)
      .order("finished_at", { ascending: false })
      .limit(2000);

    // 按 endpoint 分組統計
    const endpointMap = new Map<string, {
      last_ok: string | null;
      last_error: string | null;
      ok_1h: number;
      err_1h: number;
    }>();
    for (const row of ingestRows ?? []) {
      const ep = row.endpoint as string;
      const cur = endpointMap.get(ep) ?? { last_ok: null, last_error: null, ok_1h: 0, err_1h: 0 };
      const isRecent = row.finished_at >= since1h;
      if (row.status === "ok") {
        if (!cur.last_ok || row.finished_at > cur.last_ok) cur.last_ok = row.finished_at;
        if (isRecent) cur.ok_1h++;
      } else {
        if (!cur.last_error || row.finished_at > cur.last_error) cur.last_error = row.finished_at;
        if (isRecent) cur.err_1h++;
      }
      endpointMap.set(ep, cur);
    }

    // 判斷 cron 是否過期（超過容差未見 ok 記錄）
    const cronHealth = Object.entries(CRON_INGEST_ENDPOINTS).map(([ep, maxAgeSec]) => {
      const stats = endpointMap.get(ep);
      const lastOkMs = stats?.last_ok ? new Date(stats.last_ok).getTime() : null;
      const ageMs = lastOkMs != null ? now - lastOkMs : null;
      const stale = ageMs == null || ageMs > maxAgeSec * 1000;
      return {
        endpoint: ep,
        last_ok: stats?.last_ok ?? null,
        last_error: stats?.last_error ?? null,
        ok_1h: stats?.ok_1h ?? 0,
        err_1h: stats?.err_1h ?? 0,
        stale,
        max_age_sec: maxAgeSec,
      };
    });

    // ── 4. pg_cron 工作排程（wx_cron_status RPC）────────────
    const { data: cronJobs, error: cronErr } = await supabase.rpc("wx_cron_status");
    const cronJobsOut = (cronJobs ?? []).map((j: any) => ({
      jobname: j.jobname,
      schedule: j.schedule,
      active: j.active,
      next_run: j.next_run,
    }));

    // ── 5. 資料新鮮度（key tables）────────────────────────────
    const [{ data: latestHourly }, { data: latestDaily }, { data: latestAlert }] =
      await Promise.all([
        supabase
          .from("wx_hourly_series")
          .select("valid_time")
          .order("valid_time", { ascending: false })
          .limit(1),
        supabase
          .from("wx_daily_series")
          .select("fetched_at")
          .order("fetched_at", { ascending: false })
          .limit(1),
        supabase
          .from("wx_alerts")
          .select("created_at")
          .order("created_at", { ascending: false })
          .limit(1),
      ]);

    const response = {
      version: VERSION,
      ts,
      db: {
        ok: dbOk,
        error: dbError,
      },
      providers: phErr ? null : providers,
      cron_jobs: cronErr ? null : cronJobsOut,
      cron_health: cronHealth,
      data_freshness: {
        latest_hourly_valid_time: (latestHourly ?? [])[0]?.valid_time ?? null,
        latest_daily_fetched_at:  (latestDaily  ?? [])[0]?.fetched_at  ?? null,
        latest_alert_created_at:  (latestAlert  ?? [])[0]?.created_at  ?? null,
      },
    };

    // 如果 DB 掛掉，回傳 503
    const httpStatus = dbOk ? 200 : 503;
    return jsonResponse(response, httpStatus);
  } catch (e) {
    return jsonError(e);
  }
});
