-- UTC 時區標準化：wx_daily_series 加 date_tz 欄位
-- 背景：
--   v0.9.0 以前 Open-Meteo 使用 timezone=auto，date 欄位儲存本地日期，
--   DB query 卻以 UTC today 過濾，導致 UTC-/+ 地區出現跨日誤判。
--   v0.9.1 起強制所有 provider 以 UTC 為基準（Open-Meteo 改 timezone=UTC）。
--   新增 date_tz TEXT NOT NULL DEFAULT 'UTC' 明確記錄日期所屬時區。

ALTER TABLE wx_daily_series
  ADD COLUMN IF NOT EXISTS date_tz TEXT NOT NULL DEFAULT 'UTC';

COMMENT ON COLUMN wx_daily_series.date_tz IS
  'IANA timezone of the date column. "UTC" for all providers except WeatherAPI backup which uses location-local date. Standardised to UTC from v0.9.1.';

-- 存量資料：Open-Meteo 原以 timezone=auto 寫入，日期為本地日期，
-- 無法事後還原正確 UTC 日期，標記為 UNKNOWN 提示清理。
UPDATE wx_daily_series
  SET date_tz = 'UNKNOWN'
  WHERE fetched_at < '2026-05-03T00:00:00Z'
    AND provider = 'open_meteo';

-- 其他 provider（tomorrow_io、openweather）原本就以 UTC 為基準，保持 'UTC'。
-- WeatherAPI 備援 provider 的日期仍為本地日期，標記供未來識別。
UPDATE wx_daily_series
  SET date_tz = 'LOCAL'
  WHERE fetched_at < '2026-05-03T00:00:00Z'
    AND provider = 'weatherapi';
