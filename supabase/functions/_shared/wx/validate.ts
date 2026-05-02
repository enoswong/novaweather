// 修改說明：提供 /wx/* 輸入參數驗證與正規化
// 影響文件：supabase/functions/_shared/wx/validate.ts

export class HttpError extends Error {
  status: number;
  expose: boolean;
  constructor(status: number, message: string, expose = true) {
    super(message);
    this.status = status;
    this.expose = expose;
  }
}

export function parseNumber(
  value: string | null,
  name: string,
): number {
  if (value === null || value.trim() === "") {
    throw new HttpError(400, `Missing query param: ${name}`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new HttpError(400, `Invalid number: ${name}`);
  return n;
}

export function clampInt(
  value: number,
  min: number,
  max: number,
  name: string,
): number {
  if (!Number.isInteger(value)) throw new HttpError(400, `Invalid integer: ${name}`);
  if (value < min || value > max) {
    throw new HttpError(400, `Out of range: ${name}`);
  }
  return value;
}

export function validateLatLon(lat: number, lon: number) {
  if (lat < -90 || lat > 90) throw new HttpError(400, "Invalid lat");
  if (lon < -180 || lon > 180) throw new HttpError(400, "Invalid lon");
}

