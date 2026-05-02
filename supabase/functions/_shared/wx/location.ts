// 修改說明：統一解析 location（支援 lat/lon 與 place_id），並回傳可附加到 meta 的國家/地區資訊
// 影響文件：supabase/functions/_shared/wx/location.ts

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { encodeGeohash } from "./geohash.ts";
import { HttpError, parseNumber, validateLatLon } from "./validate.ts";

export type WxResolvedLocation = {
  lat: number;
  lon: number;
  geohash: string;
  timezone: string;
  place_id: string | null;
  country_code: string | null;
  admin1: string | null;
  admin2: string | null;
  admin3: string | null;
  admin4: string | null;
  locality: string | null;
  name: string | null;
};

export async function resolveLocationFromRequest(args: {
  url: URL;
  supabase: SupabaseClient;
  geohashPrecision?: number;
}): Promise<WxResolvedLocation> {
  const { url, supabase, geohashPrecision = 6 } = args;

  const placeId = (url.searchParams.get("place_id") ?? "").trim() || null;
  if (placeId) {
    const { data, error } = await supabase
      .from("wx_locations")
      .select("lat,lon,geohash,timezone,place_id,country_code,admin1,admin2,admin3,admin4,locality,name")
      .eq("place_id", placeId)
      .limit(1);
    if (error) throw error;
    const row = (data ?? [])[0] ?? null;
    if (!row) throw new HttpError(404, "Unknown place_id");

    return {
      lat: row.lat,
      lon: row.lon,
      geohash: row.geohash,
      timezone: row.timezone,
      place_id: row.place_id ?? placeId,
      country_code: row.country_code ?? null,
      admin1: row.admin1 ?? null,
      admin2: row.admin2 ?? null,
      admin3: row.admin3 ?? null,
      admin4: row.admin4 ?? null,
      locality: row.locality ?? null,
      name: row.name ?? null,
    };
  }

  const lat = parseNumber(url.searchParams.get("lat"), "lat");
  const lon = parseNumber(url.searchParams.get("lon"), "lon");
  validateLatLon(lat, lon);

  // lat/lon 路徑：若有已存在的 wx_locations（同 geohash），可補 meta；否則使用 UTC + null。
  const geohash = encodeGeohash(lat, lon, geohashPrecision);
  const { data, error } = await supabase
    .from("wx_locations")
    .select("timezone,country_code,admin1,admin2,admin3,admin4,locality,name,place_id")
    .eq("geohash", geohash)
    .limit(1);
  if (error) throw error;
  const row = (data ?? [])[0] ?? null;

  return {
    lat,
    lon,
    geohash,
    timezone: row?.timezone ?? "UTC",
    place_id: row?.place_id ?? null,
    country_code: row?.country_code ?? null,
    admin1: row?.admin1 ?? null,
    admin2: row?.admin2 ?? null,
    admin3: row?.admin3 ?? null,
    admin4: row?.admin4 ?? null,
    locality: row?.locality ?? null,
    name: row?.name ?? null,
  };
}

