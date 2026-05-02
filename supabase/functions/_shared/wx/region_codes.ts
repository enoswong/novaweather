// 修改說明：集中管理 region_code 生成、種子資料與映射同步流程
// 影響文件：supabase/functions/_shared/wx/region_codes.ts

type RegionCodeRow = {
  country_code: string;
  region_code: string;
  region_name: string;
  geohash: string;
  place_id: string;
  lat: number;
  lon: number;
  timezone: string;
  admin1: string | null;
  admin2: string | null;
  admin3: string | null;
  admin4: string | null;
  locality: string | null;
  name: string | null;
  updated_at: string;
};

export function toRegionCode(name: string, geohash: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "region"}-${String(geohash).slice(0, 6)}`;
}

export function getSeedRegionRows(): RegionCodeRow[] {
  const now = new Date().toISOString();
  return [
    {
      country_code: "HK",
      region_code: "hong-kong-central-wecnyk",
      region_name: "Hong Kong Central",
      geohash: "wecnyk",
      place_id: "seed:hk:central",
      lat: 22.306927,
      lon: 114.183064,
      timezone: "Asia/Hong_Kong",
      admin1: "Hong Kong",
      admin2: null,
      admin3: null,
      admin4: null,
      locality: null,
      name: "Hong Kong",
      updated_at: now,
    },
    {
      country_code: "CN",
      region_code: "shenzhen-nanshan-ws1078",
      region_name: "Shenzhen Nanshan",
      geohash: "ws1078",
      place_id: "seed:cn:shenzhen",
      lat: 22.548097,
      lon: 114.061154,
      timezone: "Asia/Shanghai",
      admin1: "Guangdong",
      admin2: "Shenzhen",
      admin3: null,
      admin4: null,
      locality: "Nanshan",
      name: "Shenzhen",
      updated_at: now,
    },
    {
      country_code: "MO",
      region_code: "macau-urban-ws0e9t",
      region_name: "Macau Urban",
      geohash: "ws0e9t",
      place_id: "seed:mo:urban",
      lat: 22.198745,
      lon: 113.543873,
      timezone: "Asia/Macau",
      admin1: "Macau",
      admin2: null,
      admin3: null,
      admin4: null,
      locality: null,
      name: "Macau",
      updated_at: now,
    },
    {
      country_code: "TW",
      region_code: "taipei-city-wsqqqq",
      region_name: "Taipei City",
      geohash: "wsqqqq",
      place_id: "seed:tw:taipei",
      lat: 25.033,
      lon: 121.5654,
      timezone: "Asia/Taipei",
      admin1: "Taipei",
      admin2: null,
      admin3: null,
      admin4: null,
      locality: null,
      name: "Taipei",
      updated_at: now,
    },
    {
      country_code: "JP",
      region_code: "tokyo-chiyoda-xn774c",
      region_name: "Tokyo Chiyoda",
      geohash: "xn774c",
      place_id: "seed:jp:tokyo",
      lat: 35.6895,
      lon: 139.6917,
      timezone: "Asia/Tokyo",
      admin1: "Tokyo",
      admin2: "Chiyoda",
      admin3: null,
      admin4: null,
      locality: null,
      name: "Tokyo",
      updated_at: now,
    },
    {
      country_code: "US",
      region_code: "new-york-manhattan-dr5reg",
      region_name: "New York Manhattan",
      geohash: "dr5reg",
      place_id: "seed:us:nyc",
      lat: 40.7128,
      lon: -74.006,
      timezone: "America/New_York",
      admin1: "New York",
      admin2: "New York County",
      admin3: null,
      admin4: null,
      locality: "Manhattan",
      name: "New York",
      updated_at: now,
    },
  ];
}

export async function ensureSeedRegionCodes(supabase: any): Promise<number> {
  const rows = getSeedRegionRows();
  const { error } = await supabase.from("wx_region_codes").upsert(rows, { onConflict: "geohash" });
  if (error) throw error;
  return rows.length;
}

export async function syncRegionCodesFromLocations(supabase: any): Promise<number> {
  const { data, error } = await supabase
    .from("wx_locations")
    .select("country_code,geohash,place_id,lat,lon,timezone,admin1,admin2,admin3,admin4,locality,name")
    .not("country_code", "is", null)
    .not("geohash", "is", null)
    .limit(5000);
  if (error) throw error;
  const locations = Array.isArray(data) ? data : [];
  if (locations.length === 0) return 0;

  const now = new Date().toISOString();
  const rows = locations.map((l: any) => {
    const regionName = String(l.locality ?? l.admin4 ?? l.admin3 ?? l.admin2 ?? l.admin1 ?? l.name ?? l.geohash);
    return {
      country_code: String(l.country_code).toUpperCase(),
      region_code: toRegionCode(regionName, String(l.geohash)),
      region_name: regionName,
      geohash: l.geohash,
      place_id: String(l.place_id ?? `loc:${l.geohash}`),
      lat: l.lat,
      lon: l.lon,
      timezone: String(l.timezone ?? "UTC"),
      admin1: l.admin1 ?? null,
      admin2: l.admin2 ?? null,
      admin3: l.admin3 ?? null,
      admin4: l.admin4 ?? null,
      locality: l.locality ?? null,
      name: l.name ?? null,
      updated_at: now,
    };
  });

  const { error: upErr } = await supabase.from("wx_region_codes").upsert(rows, { onConflict: "geohash" });
  if (upErr) throw upErr;
  return rows.length;
}

type OpenMeteoReverseResult = {
  id: number;
  name?: string;
  latitude: number;
  longitude: number;
  country_code?: string;
  admin1?: string;
  admin2?: string;
  admin3?: string;
  admin4?: string;
  locality?: string;
  timezone?: string;
};

async function reverseGeocodeOne(lat: number, lon: number): Promise<OpenMeteoReverseResult | null> {
  const upstream = new URL("https://geocoding-api.open-meteo.com/v1/reverse");
  upstream.searchParams.set("latitude", String(lat));
  upstream.searchParams.set("longitude", String(lon));
  upstream.searchParams.set("count", "1");
  upstream.searchParams.set("language", "en");
  const res = await fetch(upstream, { headers: { "user-agent": "novaweather-region-hotspot-sync/0.4.3" } });
  if (!res.ok) return null;
  const data = await res.json();
  const r = data?.results?.[0];
  if (!r || typeof r.id !== "number") return null;
  return r as OpenMeteoReverseResult;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * [!note] 從預抓熱點反查行政區，將全球主要網格納入 region 映射（不依賴使用者先呼叫 geo-forward）。
 */
export async function syncRegionCodesFromHotspots(args: {
  supabase: any;
  /** 本次最多處理幾個熱點，避免 Edge 逾時 */
  limit?: number;
  /** 並行 reverse 請求數 */
  concurrency?: number;
}): Promise<{ upserted: number; failed: number; skipped: number }> {
  const limit = Math.min(Math.max(Number(args.limit ?? 80), 1), 500);
  const concurrency = Math.min(Math.max(Number(args.concurrency ?? 8), 1), 20);

  const { data: hotspots, error } = await args.supabase
    .from("wx_hotspots")
    .select("geohash,lat,lon,priority")
    .order("priority", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const list = Array.isArray(hotspots) ? hotspots : [];
  if (list.length === 0) return { upserted: 0, failed: 0, skipped: 0 };

  const ghList = list.map((h: { geohash: string }) => h.geohash);
  const { data: existing, error: exErr } = await args.supabase
    .from("wx_region_codes")
    .select("geohash,place_id")
    .in("geohash", ghList);
  if (exErr) throw exErr;
  const alreadyHotspot = new Set(
    (existing ?? []).filter((r: { place_id?: string }) => String(r.place_id ?? "").startsWith("hotspot:")).map((r: { geohash: string }) => r.geohash),
  );

  const skipped = list.filter((h: { geohash: string }) => alreadyHotspot.has(h.geohash)).length;
  const now = new Date().toISOString();

  const pending = list.filter((h: { geohash: string }) => !alreadyHotspot.has(h.geohash));

  const rows = await mapWithConcurrency(pending, concurrency, async (h: { geohash: string; lat: number; lon: number }) => {
    const r = await reverseGeocodeOne(h.lat, h.lon);
    if (!r) return null;
    const cc = String(r.country_code ?? "").trim().toUpperCase();
    if (!cc || !/^[A-Z]{2}$/.test(cc)) return null;
    const regionName = String(r.locality ?? r.admin4 ?? r.admin3 ?? r.admin2 ?? r.admin1 ?? r.name ?? h.geohash);
    return {
      country_code: cc,
      region_code: toRegionCode(regionName, String(h.geohash)),
      region_name: regionName,
      geohash: h.geohash,
      place_id: `hotspot:open_meteo:${r.id}`,
      lat: h.lat,
      lon: h.lon,
      timezone: String(r.timezone ?? "UTC").trim() || "UTC",
      admin1: r.admin1 ?? null,
      admin2: r.admin2 ?? null,
      admin3: r.admin3 ?? null,
      admin4: r.admin4 ?? null,
      locality: r.locality ?? null,
      name: r.name ?? null,
      updated_at: now,
    };
  });

  const good = rows.flatMap((row) => (row == null ? [] : [row]));
  const failed = pending.length - good.length;

  if (good.length === 0) {
    return { upserted: 0, failed, skipped };
  }

  const { error: upErr } = await args.supabase.from("wx_region_codes").upsert(good, { onConflict: "geohash" });
  if (upErr) throw upErr;

  return { upserted: good.length, failed, skipped };
}
