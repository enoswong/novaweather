// 修改說明：提供 geohash 編碼（用於快取分格 key）
// 影響文件：supabase/functions/_shared/wx/geohash.ts

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export function encodeGeohash(lat: number, lon: number, precision = 6): string {
  let latMin = -90.0, latMax = 90.0;
  let lonMin = -180.0, lonMax = 180.0;

  let hash = "";
  let bit = 0;
  let ch = 0;
  let even = true;

  while (hash.length < precision) {
    if (even) {
      const lonMid = (lonMin + lonMax) / 2;
      if (lon >= lonMid) {
        ch |= 1 << (4 - bit);
        lonMin = lonMid;
      } else {
        lonMax = lonMid;
      }
    } else {
      const latMid = (latMin + latMax) / 2;
      if (lat >= latMid) {
        ch |= 1 << (4 - bit);
        latMin = latMid;
      } else {
        latMax = latMid;
      }
    }

    even = !even;
    if (bit < 4) {
      bit++;
    } else {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }

  return hash;
}

