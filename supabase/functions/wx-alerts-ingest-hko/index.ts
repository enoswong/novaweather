// 修改說明：港澳插件：抓取香港天文台警報摘要（warnsum）寫入 wx_alerts
// 影響文件：supabase/functions/wx-alerts-ingest-hko/index.ts

import { jsonError, jsonResponse } from "../_shared/wx/http.ts";
import { getSupabaseAdminClient } from "../_shared/wx/supabase.ts";
import { recordIngestRun } from "../_shared/wx/storage.ts";

type HkoWarnsum = {
  type?: string;
  name?: string;
  code?: string;
  actionCode?: string;
  issueTime?: string;
  updateTime?: string;
  expireTime?: string;
  contents?: string;
};

type HkoWarnsumResponse = {
  warningSummary?: Record<string, HkoWarnsum>;
};

function severityFromText(text: string): "info" | "yellow" | "orange" | "red" | "emergency" {
  const t = text.toLowerCase();
  if (t.includes("black") || t.includes("emergency")) return "emergency";
  if (t.includes("red")) return "red";
  if (t.includes("amber") || t.includes("orange")) return "orange";
  if (t.includes("yellow")) return "yellow";
  return "info";
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
    const supabase = getSupabaseAdminClient();

    const endpoint = "hko_warnsum";
    const geohash = "hongkong"; // 插件級：先不做 geo filter
    const t0 = performance.now();
    const url = "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=warnsum&lang=en";

    const res = await fetch(url);
    const latency = Math.round(performance.now() - t0);
    if (!res.ok) throw new Error(`HKO warnsum HTTP ${res.status}`);

    const data = (await res.json()) as HkoWarnsumResponse;
    const warnings = data.warningSummary ?? {};

    // 先清掉舊的 HKO（簡化；後續可用 upsert + 結束時間策略）
    await supabase.from("wx_alerts").delete().eq("source", "HKO");

    const rows = Object.values(warnings).map((w) => {
      const title = w.name ?? w.type ?? "HKO Warning";
      const desc = w.contents ?? null;
      const issue = w.issueTime ? new Date(w.issueTime).toISOString() : null;
      const expire = w.expireTime ? new Date(w.expireTime).toISOString() : null;
      const severity = severityFromText(`${w.code ?? ""} ${w.name ?? ""} ${w.actionCode ?? ""} ${w.contents ?? ""}`);
      return {
        source: "HKO",
        severity,
        title,
        description: desc,
        starts_at: issue,
        ends_at: expire,
        bbox: null,
        geohash_prefixes: null,
        raw: w,
      };
    });

    if (rows.length) {
      const { error } = await supabase.from("wx_alerts").insert(rows);
      if (error) throw error;
    }

    await recordIngestRun(supabase, {
      provider: "HKO",
      geohash,
      endpoint,
      status: "ok",
      latency_ms: Number.isFinite(latency) ? latency : null,
      http_status: res.status,
      error: null,
    });

    return jsonResponse({ ok: true, inserted: rows.length });
  } catch (e) {
    try {
      const supabase = getSupabaseAdminClient();
      await recordIngestRun(supabase, {
        provider: "HKO",
        geohash: "hongkong",
        endpoint: "hko_warnsum",
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

