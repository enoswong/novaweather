// 修改說明：Cron 任務：根據 wx_ingest_runs 刷新供應商 15 分鐘失敗率與 P95 latency
// 影響文件：supabase/functions/wx-provider-health-refresh/index.ts

import { jsonError, jsonResponse } from "../_shared/wx/http.ts";
import { getSupabaseAdminClient } from "../_shared/wx/supabase.ts";

function percentile(arr: number[], p: number): number | null {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const idx = Math.floor((p / 100) * (a.length - 1));
  return a[Math.max(0, Math.min(a.length - 1, idx))];
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
    const supabase = getSupabaseAdminClient();

    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("wx_ingest_runs")
      .select("provider,status,latency_ms")
      .gte("finished_at", since)
      .limit(5000);
    if (error) throw error;

    const byProvider = new Map<string, { total: number; failed: number; latencies: number[] }>();
    for (const row of data ?? []) {
      const provider = row.provider ?? "unknown";
      const cur = byProvider.get(provider) ?? { total: 0, failed: 0, latencies: [] };
      cur.total++;
      if (row.status !== "ok") cur.failed++;
      if (typeof row.latency_ms === "number" && Number.isFinite(row.latency_ms)) {
        cur.latencies.push(row.latency_ms);
      }
      byProvider.set(provider, cur);
    }

    let updated = 0;
    for (const [provider, stats] of byProvider.entries()) {
      const failure_rate_15m = stats.total ? stats.failed / stats.total : null;
      const p95 = percentile(stats.latencies, 95);
      const circuit_open_until = failure_rate_15m != null && failure_rate_15m >= 0.8
        ? new Date(Date.now() + 10 * 60 * 1000).toISOString()
        : null;

      const { error: upErr } = await supabase.from("wx_provider_health").upsert({
        provider,
        failure_rate_15m,
        p95_latency_ms: p95 == null ? null : Math.round(p95),
        circuit_open_until,
        updated_at: new Date().toISOString(),
      }, { onConflict: "provider" });
      if (upErr) throw upErr;
      updated++;
    }

    return jsonResponse({ ok: true, updated });
  } catch (e) {
    return jsonError(e);
  }
});

