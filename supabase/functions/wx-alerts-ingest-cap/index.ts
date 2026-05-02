// 修改說明：Cron 任務：從 wx_alert_feeds 抓取 CAP/Atom 官方警報並正規化寫入 wx_alerts
// 影響文件：supabase/functions/wx-alerts-ingest-cap/index.ts

import { jsonError, jsonResponse } from "../_shared/wx/http.ts";
import { getSupabaseAdminClient } from "../_shared/wx/supabase.ts";

function allMatches(text: string, re: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

function allBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function textBetween(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? decodeHtml(m[1].trim()) : null;
}

function decodeHtml(s: string): string {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function severityToNova(sev: string | null): "info" | "yellow" | "orange" | "red" | "emergency" {
  const s = (sev ?? "").toLowerCase();
  if (s.includes("extreme")) return "emergency";
  if (s.includes("severe")) return "red";
  if (s.includes("moderate")) return "orange";
  if (s.includes("minor")) return "yellow";
  return "info";
}

function parsePolygon(polygon: string): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (const part of polygon.trim().split(/\s+/)) {
    const [latS, lonS] = part.split(",");
    const lat = Number(latS);
    const lon = Number(lonS);
    if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push([lat, lon]);
  }
  return pts;
}

function centroid(points: Array<[number, number]>): { lat: number; lon: number } | null {
  if (!points.length) return null;
  const sum = points.reduce((acc, [lat, lon]) => ({ lat: acc.lat + lat, lon: acc.lon + lon }), { lat: 0, lon: 0 });
  return { lat: sum.lat / points.length, lon: sum.lon / points.length };
}

function pointEwkt(lat: number, lon: number): string {
  return `SRID=4326;POINT(${lon} ${lat})`;
}

async function fetchText(url: string): Promise<{ status: number; text: string; latency: number }> {
  const t0 = performance.now();
  const res = await fetch(url, { headers: { "user-agent": "novaweather-cap/0.2.5" } });
  const latency = Math.round(performance.now() - t0);
  const text = await res.text();
  if (!res.ok) throw new Error(`CAP HTTP ${res.status}`);
  return { status: res.status, text, latency };
}

function extractCapLinksFromAtom(atomXml: string): string[] {
  const links: string[] = [];
  for (const entry of allBlocks(atomXml, "entry")) {
    for (const href of allMatches(entry, /<link[^>]+href=["']([^"']+)["'][^>]*>/gi)) {
      if (href.includes("cap") || href.endsWith(".xml")) links.push(href);
    }
    const content = textBetween(entry, "content");
    if (content && content.includes("<alert")) {
      links.push(`data:text/xml,${encodeURIComponent(content)}`);
    }
  }
  return Array.from(new Set(links)).slice(0, 200);
}

async function getAlertBlocks(url: string): Promise<string[]> {
  const feed = await fetchText(url);
  if (feed.text.includes("<alert")) return allBlocks(feed.text, "alert");
  const links = extractCapLinksFromAtom(feed.text);
  const out: string[] = [];
  for (const href of links) {
    try {
      if (href.startsWith("data:text/xml,")) {
        out.push(...allBlocks(decodeURIComponent(href.split(",")[1] ?? ""), "alert"));
        continue;
      }
      const cap = await fetchText(href);
      out.push(...allBlocks(cap.text, "alert"));
    } catch {
      // 單一 CAP 失敗不阻斷整個 feed
    }
  }
  return out;
}

function buildRow(args: {
  source: string;
  country_code: string | null;
  region_code: string | null;
  alertXml: string;
  feedUrl: string;
}) {
  const info = allBlocks(args.alertXml, "info")[0] ?? "";
  const identifier = textBetween(args.alertXml, "identifier") ?? `${args.source}:${crypto.randomUUID()}`;
  const sent = textBetween(args.alertXml, "sent");
  const event = textBetween(info, "event") ?? "CAP Alert";
  const headline = textBetween(info, "headline") ?? event;
  const description = textBetween(info, "description");
  const onset = textBetween(info, "onset");
  const expires = textBetween(info, "expires");

  let center: { lat: number; lon: number } | null = null;
  for (const area of allBlocks(info, "area")) {
    const polygon = textBetween(area, "polygon");
    if (!polygon) continue;
    center = centroid(parsePolygon(polygon));
    if (center) break;
  }

  const row: Record<string, unknown> = {
    source: args.source,
    country_code: args.country_code,
    region_code: args.region_code,
    event_type: event,
    severity: severityToNova(textBetween(info, "severity")),
    title: headline,
    description,
    starts_at: onset ? new Date(onset).toISOString() : null,
    ends_at: expires ? new Date(expires).toISOString() : null,
    ext_id: identifier,
    sent_at: sent ? new Date(sent).toISOString() : null,
    updated_at: new Date().toISOString(),
    raw: { feed: args.feedUrl, identifier, sent, event },
  };

  if (center) row.area_center = pointEwkt(center.lat, center.lon);
  return row;
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
    const supabase = getSupabaseAdminClient();

    const { data: feeds, error } = await supabase
      .from("wx_alert_feeds")
      .select("id,source,country_code,region_code,url")
      .eq("is_enabled", true)
      .limit(200);
    if (error) throw error;

    let upserted = 0;
    for (const feed of feeds ?? []) {
      const t0 = performance.now();
      try {
        const alerts = await getAlertBlocks(feed.url);
        for (const alertXml of alerts) {
          const row = buildRow({
            source: feed.source,
            country_code: feed.country_code,
            region_code: feed.region_code,
            alertXml,
            feedUrl: feed.url,
          });
          const { error: upErr } = await supabase.from("wx_alerts").upsert(row, { onConflict: "source,ext_id" });
          if (!upErr) upserted++;
        }

        await supabase.from("wx_ingest_runs").insert({
          provider: feed.source,
          geohash: "global",
          endpoint: "cap_feed",
          finished_at: new Date().toISOString(),
          latency_ms: Math.round(performance.now() - t0),
          status: "ok",
          http_status: 200,
          error: null,
        });
        await supabase.from("wx_alert_feeds").update({ last_fetched_at: new Date().toISOString() }).eq("id", feed.id);
      } catch (e) {
        await supabase.from("wx_ingest_runs").insert({
          provider: feed.source,
          geohash: "global",
          endpoint: "cap_feed",
          finished_at: new Date().toISOString(),
          latency_ms: Math.round(performance.now() - t0),
          status: "error",
          http_status: null,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return jsonResponse({ ok: true, upserted });
  } catch (e) {
    return jsonError(e);
  }
});

