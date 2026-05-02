// 修改說明：港澳插件：抓取澳門 SMG 官網訊號頁（最小可用 HTML 抽取）寫入 wx_alerts
// 影響文件：supabase/functions/wx-alerts-ingest-smg/index.ts

import { jsonError, jsonResponse } from "../_shared/wx/http.ts";
import { getSupabaseAdminClient } from "../_shared/wx/supabase.ts";
import { recordIngestRun } from "../_shared/wx/storage.ts";

function pickTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!m) return null;
  return m[1].trim();
}

function severityFromTitle(title: string): "info" | "yellow" | "orange" | "red" | "emergency" {
  const t = title.toLowerCase();
  if (t.includes("black")) return "emergency";
  if (t.includes("red")) return "red";
  if (t.includes("amber") || t.includes("orange")) return "orange";
  if (t.includes("yellow")) return "yellow";
  return "info";
}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": "novaheart-wx/0.1" },
  });
  if (!res.ok) throw new Error(`SMG HTTP ${res.status}`);
  return await res.text();
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
    const supabase = getSupabaseAdminClient();

    const geohash = "macau";
    const endpoint = "smg_site_signals";
    const t0 = performance.now();

    const pages = [
      "https://www.smg.gov.mo/en/subpage/28/typhoon-main",
      "https://www.smg.gov.mo/en/subpage/34/thunderstorm-main",
      "https://www.smg.gov.mo/en/temperature-main",
    ];

    const results: Array<{ url: string; title: string; severity: string }> = [];
    for (const url of pages) {
      try {
        const html = await fetchPage(url);
        const title = pickTitle(html) ?? "SMG Signal";
        results.push({ url, title, severity: severityFromTitle(title) });
      } catch {
        // 單頁失敗不阻斷
      }
    }

    // 先清掉舊的 SMG（簡化）
    await supabase.from("wx_alerts").delete().eq("source", "SMG");

    const rows = results.map((r) => ({
      source: "SMG",
      severity: r.severity,
      title: r.title,
      description: r.url,
      starts_at: null,
      ends_at: null,
      bbox: null,
      geohash_prefixes: null,
      raw: r,
    }));

    if (rows.length) {
      const { error } = await supabase.from("wx_alerts").insert(rows);
      if (error) throw error;
    }

    const latency = Math.round(performance.now() - t0);
    await recordIngestRun(supabase, {
      provider: "SMG",
      geohash,
      endpoint,
      status: "ok",
      latency_ms: Number.isFinite(latency) ? latency : null,
      http_status: 200,
      error: null,
    });

    return jsonResponse({ ok: true, inserted: rows.length, pages: results.length });
  } catch (e) {
    try {
      const supabase = getSupabaseAdminClient();
      await recordIngestRun(supabase, {
        provider: "SMG",
        geohash: "macau",
        endpoint: "smg_site_signals",
        status: "error",
        latency_ms: null,
        http_status: null,
        error: e instanceof Error ? e.message : String(e),
      });
    } catch {
      // ignore
    }
    return jsonError(e);
  }
});

