## 版本狀態 v0.8.0
✅ 已完成 | ▢ 進行中 | ✖️ 已移除
- [✅] NovaWeather API DOC [進度 100%] (v0.2.5)
- [✅] Environment Timeline API [進度 100%] (v0.3.0)
- [✅] Country/Region + Region Sync API [進度 100%] (v0.4.1)
- [✅] Region Coverage Health API [進度 100%] (v0.4.2)
- [✅] Region Sync 來源擴充：wx_hotspots 反查映射 [進度 100%] (v0.4.3)
- [✅] Geo-Reverse 修正（Nominatim OSM）+ SMG 警報地理 + CAP bbox [進度 100%] (v0.5.0)
- [✅] Air Quality API + METAR 觀測 + NWS GeoJSON 警報 + wx-status [進度 100%] (v0.5.0)
- [✅] Marine API + Solar API + Historical Archive API + Astronomy API [進度 100%] (v0.6.0)
- [✅] Bundle API（單請求並行多資料集）+ 供應商 10s 超時修正 [進度 100%] (v0.7.0)
- [✅] 複合指數 API + 多地比較 API + 氣候異常偵測 API [進度 100%] (v0.8.0)
- [✅] Webhook 推送 API（訂閱警報/風險事件，HMAC 簽名，每 5 分鐘派送）[進度 100%] (v0.9.0)

## 概述
NovaWeather 對外只提供一組穩定的 `/wx/*` HTTP API，用於：
- **全球天氣預報**（hourly / daily）
- **近似即時觀測**（observed now + 熱點 observed rolling）
- **官方警報**（CAP/Atom feeds + 港澳官方來源），並支援 **座標 + 半徑**查詢
- **風險 / 環境變化**（以預報 + 附近官方警報計算 risk level + reasons）
- **後端維運 API**（熱點預取、清 cache、修剪時間序列、供應商健康度、alerts 清理、熱點種子匯入）

設計原則：
- **SI 單位**：所有數值以 SI/通用單位回傳（溫度 °C、風 m/s、雨量 mm、壓力 hPa）。
- **缺值策略**：供應商缺少的欄位回 `null`（不改結構、不改欄位名）。
- **可追溯性**：回應 meta 會包含 `provider` 與 `fetched_at`。

## Base URL
- `https://<project-ref>.supabase.co/functions/v1`

## 認證與安全
### 公開讀取（GET）
目前 `/wx/*` 的 GET API 設計成可公開讀取（仍建議在產品層加上 rate limit / WAF）。

### 受控寫入（POST / 排程任務）
所有會寫入資料庫、清理資料、或 ingest 的 POST functions **只能在安全環境**呼叫（例如 Scheduler），請使用：
- Header：`Authorization: Bearer <SERVICE_ROLE>`

> 禁止在前端/客戶端使用 `service_role`。詳見 `docs/security.md`。

## 通用 Query 參數（GET）
- `lat`：緯度（-90 ~ 90）
- `lon`：經度（-180 ~ 180）
- `place_id`：精準位置識別（可選；建議搭配 `/wx/geo/forward` 取得）
- `provider`：`auto | open_meteo | weatherapi | tomorrow_io | openweather`
  - 預設：`auto`（依優先序自動回退）
- `allow_live_fetch`：`true | false`（forecast 可選）
  - 預設：`true`
  - 若設為 `false`，API 僅輸出 cron 已寫入的 `wx_cache` / `wx_*_series` 資料。

## 通用回應 meta
多數 GET 端點回應都會包含：
- `fetched_at`：ISO 8601 UTC
- `timezone`：IANA timezone（例如 `Asia/Hong_Kong`）
- `lat` / `lon` / `geohash`
- `place_id` / `country_code` / `admin1` / `admin2` / `admin3` / `admin4` / `locality` / `name`（若可得）
- `provider`（若端點涉及供應商）

## API：Geo（精準位置 / 國家地區細化）

### `GET /wx/geo/forward`
把地名查詢成候選位置清單（Open‑Meteo Geocoding），回傳 `place_id` 供後續查詢使用。

**Query**
- `q`（必填）
  - 支援路徑輸入：例如 `香港/天水圍`、`廣東省/深圳/寶安區`（會用前置段做候選過濾）
- `country_code`：ISO-3166-1 alpha-2（可選，例如 `US`）
- `language`（可選）
- `limit`：1–50（可選，預設 10）

**Response**
- `meta`: `{ q, name_query, path_hints, limit, language, country_code, upstream_latency_ms }`
- `places`: `{ place_id, name, lat, lon, geohash, timezone, country_code, admin1, admin2, admin3, admin4, locality, feature_code, population }[]`

### `GET /wx/geo/reverse`
把座標反查成最近的行政區資訊（Open‑Meteo Reverse Geocoding）。

**Query**
- `lat` `lon`（必填）
- `language`（可選）

**Response**
- `meta`: `{ lat, lon, language, upstream_latency_ms }`
- `place`: `{ place_id, name, lat, lon, geohash, timezone, country_code, admin1, admin2, admin3, admin4, locality, feature_code } | null`

## API：Forecast

### `GET /wx/forecast/hourly`
取得未來小時級預報。

**Query**
- `lat` `lon`（與 `place_id` 二擇一）
- `place_id`（與 `lat/lon` 二擇一）
- `hours`：1–168（可選；預設 72）
- `provider`（可選；預設 `auto`）

**Response**
- `meta`: `{ provider, fetched_at, timezone, lat, lon, geohash, hours }`
- `hourly`: `WxHourlyPoint[]`

**範例**
```bash
curl "<BASE>/wx-forecast-hourly?lat=22.3193&lon=114.1694&hours=72"
```

### `GET /wx/forecast/daily`
取得未來日級預報。

**Query**
- `lat` `lon`（與 `place_id` 二擇一）
- `place_id`（與 `lat/lon` 二擇一）
- `days`：1–16（可選；預設 14）
- `provider`（可選；預設 `auto`）

**Response**
- `meta`: `{ provider, fetched_at, timezone, lat, lon, geohash, days }`
- `daily`: `WxDailyPoint[]`

## API：Observed

### `GET /wx/observed/now`
取得近似即時的觀測值（目前策略：以資料庫內最新 observed / 最近序列近似 current）。

**Query**
- `lat` `lon`（與 `place_id` 二擇一）
- `place_id`（與 `lat/lon` 二擇一）

**Response**
- `meta`: `{ fetched_at, timezone, lat, lon, geohash }`
- `observed`: `WxObservedPoint | null`

## API：Alerts（官方警報）

### `GET /wx/alerts`
取得座標附近的「仍在有效期」官方警報（目前為 bbox-based RPC；未提供 bbox 的來源會保留在結果中）。

**Query**
- `lat` `lon`（與 `place_id` 二擇一）
- `place_id`（與 `lat/lon` 二擇一）
- `radius_km`：1–300（可選；預設 50）

**Response**
- `meta`: `{ fetched_at, lat, lon, radius_km }`
- `alerts`: `WxAlert[]`

## API：Risk（環境變化/風險）

### `GET /wx/risk`
輸出風險等級與原因，來源包括：
- 預報（溫度變化、降水、風、濕度等）
- 附近官方警報（透過 `/wx/alerts` 等效邏輯）

**Query**
- `lat` `lon`（與 `place_id` 二擇一）
- `place_id`（與 `lat/lon` 二擇一）
- `window_hours`：1–72（可選；預設 24）
- `radius_km`：1–300（可選；預設 50）

**Response**
- `meta`: `{ fetched_at, lat, lon, window_hours, radius_km }`
- `risk_level`: `0 | 1 | 2 | 3`（綠 → 黃 → 橙 → 紅）
- `reasons`: `WxRiskReason[]`

## API：Environment Timeline（分/時/日 + 未來數天）

### `GET /wx-environment-timeline`
提供全球通用環境變化時間軸，輸出：
- **minute**：未來 N 分鐘（預設 60）微時間粒度趨勢
- **hourly**：未來 N 小時（預設 72）逐小時變化
- **daily**：未來 N 天（預設 7）日級概覽
- **極端天氣判斷**：高溫、低溫、乾燥、高濕、強降雨、強風、風暴條件、官方警報加權

> 風險等級 `risk_level`：`0 | 1 | 2 | 3`（穩定/注意/警戒/高風險）

**Query**
- `lat` `lon`（與 `place_id` 二擇一）
- `place_id`（與 `lat/lon` 二擇一）
- `window_hours`：1–168（可選；預設 72）
- `minute_window`：5–180（可選；預設 60）
- `days`：1–16（可選；預設 7）
- `radius_km`：1–500（可選；預設 50；官方警報範圍）
- `provider`：`auto | open_meteo | weatherapi | tomorrow_io | openweather`
- `allow_live_fetch`：`true | false`（預設 true）

**Response**
- `meta`: `{ fetched_at, provider, timezone, lat, lon, geohash, window_hours, days, minute_window, radius_km, ...location }`
- `alerts_summary`: `{ active_count }`
- `now`: `{ observed, risk }`
- `minute`: `[{ valid_time, temp_c, humidity_pct, precip_prob, wind_ms, gust_ms, risk }]`
- `hourly`: `[{ ...WxHourlyPoint, risk }]`
- `daily`: `[{ ...WxDailyPoint, risk }]`

**risk.reasons 可能值**
- `heat_extreme`
- `cold_extreme`
- `dry_air`
- `humidity_gt_90`
- `heavy_rain_prob`
- `strong_wind`
- `storm_condition`
- `official_alert`

## API：Country / Region（新主流程）

### `GET /wx-country-today`
按 `country_code` 回傳「該國已建索引地區」的本日資料（含分頁）。

**Query**
- `country_code`（必填，ISO-3166-1 alpha-2）
- `page`：>=1（可選；預設 1）
- `page_size`：1–500（可選；預設 100）
- `include`：`summary,risk,alerts`（可選；預設 `summary,risk`）
- `radius_km`：1–500（可選；預設 50；alerts 計算範圍）

**Response**
- `meta`: `{ country_code, date, page, page_size, total_regions, total_pages, include, fetched_at }`
- `regions`: `[{ region_code, region_name, observed, today, risk, active_alert_count, ...region_meta }]`

### `GET /wx-region`
以 `country_code + region_code` 查單一地區詳細資料，並支援粒度控制。

**Query**
- `country_code`（必填）
- `region_code`（必填）
- `granularity`：`all | minute | hourly | daily`（可選；預設 `all`）
- `minute_window`：5–180（可選；預設 60）
- `hours`：1–168（可選；預設 72）
- `days`：1–16（可選；預設 7）
- `window_hours`：1–168（可選；預設 24）
- `radius_km`：1–500（可選；預設 50）
- `provider`：`auto | open_meteo | weatherapi | tomorrow_io | openweather`
- `allow_live_fetch`：`true | false`（可選；預設 true）

**Response**
- `meta`: `{ country_code, region_code, region_name, granularity, timezone, ... }`
- `now`: `{ observed, risk }`
- `alerts_summary` / `alerts`
- `minute`（當 granularity=all/minute）
- `hourly`（當 granularity=all/hourly）
- `daily`（當 granularity=all/daily）

### `GET /wx-region-coverage`
查詢 `wx_region_codes` 覆蓋率與同步健康狀態。

**Query**
- `country_code`（可選；不傳則回傳所有已有 region 的國家）

**Response**
- `meta`: `{ country_count, total_region_count, total_seed_count, total_hotspot_count, total_source_location_count, latest_region_updated_at, fetched_at }`
- `countries`: `[{ country_code, region_count, seed_count, location_count, hotspot_count, other_count, source_location_count, coverage_ratio, latest_updated_at, sample_regions }]`

## API：Air Quality（空氣質素）

### `GET /wx-air-quality`
取得指定座標的小時級空氣質素預報（Open-Meteo Air Quality API）。

**Query**
- `lat` `lon`（必填）
- `hours`：1–120（可選；預設 48）

**Response**
- `meta`: `{ lat, lon, geohash, hours, provider, timezone, fetched_at, upstream_latency_ms }`
- `hourly`: `[{ geohash, lat, lon, valid_time, pm10, pm2_5, carbon_monoxide, nitrogen_dioxide, sulphur_dioxide, ozone, aerosol_optical_depth, dust, uv_index, uv_index_clear_sky, alder_pollen, birch_pollen, grass_pollen, mugwort_pollen, olive_pollen, ragweed_pollen, us_aqi, european_aqi }]`

## API：METAR Observations（機場實況觀測）

### `GET /wx-observed-metar`
查詢全球主要機場 METAR 觀測資料（NOAA Aviation Weather Center，35 個全球優先站）。

**Query**
- `lat` `lon`（可選；若提供，僅回傳指定範圍內觀測站）
- `radius_km`：1–500（可選；預設 100）

**Response**
- `meta`: `{ lat?, lon?, radius_km?, since }`
- `observations`: `[{ station_id, geohash, lat, lon, elevation_m, observation_time, temp_c, dewpoint_c, humidity_pct, wind_dir_deg, wind_speed_ms, wind_gust_ms, visibility_m, pressure_hpa, pressure_sea_level_hpa, weather_code, raw_metar }]`

### `POST /wx-observed-metar`
刷新所有 35 個優先站的 METAR 觀測資料（排程用途）。

## API：Service Status（服務健康）

### `GET /wx-status`
回傳系統整體健康狀態、資料新鮮度與警報地理覆蓋率。

**Response**
- `ok`: boolean
- `checked_at`: ISO 8601
- `data_freshness`: `{ wx_cache_latest, wx_air_quality_latest, wx_metar_latest }`
- `counts`: `{ hotspots, region_codes, alerts_24h_by_source }`
- `alerts_geo_coverage`: `{ with_geo, without_geo, pct_geo }`
- `provider_health`: `[{ provider, success_rate_15m, p95_latency_ms, last_run_at }]`
- `ingest_last_1h`: `{ [provider]: { ok, error, last_run } }`

## API：Marine（海洋）

### `GET /wx-marine`
海洋波浪 + 海流 + 海溫預報（僅沿海/離島座標有效，內陸回 400）。

**Query Params**
- `lat`, `lon`：必填
- `forecast_days`：1–7（預設 3）

**Response**
- `meta`: `{ lat, lon, geohash, provider, fetched_at }`
- `hourly`: `[{ time, wave_height_m, wave_direction_deg, wave_period_s, wind_wave_height_m, wind_wave_direction_deg, wind_wave_period_s, swell_wave_height_m, swell_wave_direction_deg, swell_wave_period_s, sea_surface_temperature_c, ocean_current_velocity_ms, ocean_current_direction_deg }]`
- `daily`: `[{ date, wave_height_max_m, wave_direction_dominant_deg, wave_period_max_s, wind_wave_height_max_m, swell_wave_height_max_m }]`

**錯誤**
- `400`: inland location（Open-Meteo Marine 不覆蓋陸地座標）

## API：Solar Radiation（太陽輻射）

### `GET /wx-solar`
每小時太陽輻射 + 每日日出日落與輻射總量。

**Query Params**
- `lat`, `lon`：必填
- `forecast_days`：1–16（預設 7）
- `tilt`：面板傾角 deg（影響 `global_tilted_irradiance`，預設 0）
- `azimuth`：面板方位 deg（預設 0）

**Response**
- `meta`: `{ lat, lon, provider, fetched_at }`
- `hourly`: `[{ time, shortwave_radiation_w_m2, direct_radiation_w_m2, diffuse_radiation_w_m2, direct_normal_irradiance_w_m2, global_tilted_irradiance_w_m2, terrestrial_radiation_w_m2 }]`
- `daily`: `[{ date, sunrise_utc, sunset_utc, daylight_duration_s, sunshine_duration_s, shortwave_radiation_sum_mj_m2 }]`

## API：Historical Archive（歷史天氣）

### `GET /wx-historical`
1940 年至今的歷史天氣存檔（Open-Meteo Archive API）。

**Query Params**
- `lat`, `lon`：必填
- `start_date`, `end_date`：YYYY-MM-DD，必填
- `granularity`：`hourly`（最長 366 天）或 `daily`（最長 3650 天）（預設 daily）
- `variables`：逗號分隔的 Open-Meteo 變數名稱（可選，使用預設集合）

**Response**
- `meta`: `{ lat, lon, start_date, end_date, granularity, provider, source_url }`
- `data`: hourly 或 daily 陣列，欄位依 `variables` 而定
- HTTP `cache-control: public, max-age=3600`（歷史資料不變，可大力快取）

**限制**
- hourly：最長 366 天；daily：最長 3650 天（逾限回 400）
- 不含即時/預報資料（結束日需 ≤ 昨天）

## API：Astronomy（天文曆）

### `GET /wx-astronomy`
純計算日出/日落/晨昏蒙影/月相（無外部 API，0 ms 延遲）。

**Query Params**
- `lat`, `lon`：必填
- `date`：起始日 YYYY-MM-DD（預設今天）
- `days`：回傳天數 1–30（預設 7）

**Response（每天一個物件）**
```json
{
  "date": "2026-05-02",
  "sunrise_utc": "22:14",
  "sunset_utc": "11:28",
  "civil_dawn_utc": "21:47",
  "civil_dusk_utc": "11:55",
  "nautical_dawn_utc": "21:14",
  "nautical_dusk_utc": "12:28",
  "astronomical_dawn_utc": "20:40",
  "astronomical_dusk_utc": "13:02",
  "moon_phase": "Waxing Gibbous",
  "moon_illumination_pct": 68.4,
  "uv_estimate": 8.2
}
```
- `moon_phase` 值：New Moon / Waxing Crescent / First Quarter / Waxing Gibbous / Full Moon / Waning Gibbous / Last Quarter / Waning Crescent
- 所有時間為 **UTC**（`HH:MM`）；若高緯度極晝/極夜無日出/日落則該欄為 `null`

## API：Bundle（聚合）

### `GET /wx-bundle`
單請求並行抓取多個 wx-* 資料集，適合行動端減少 round-trip。

**Query Params**
- `lat`, `lon`：必填
- `include`：逗號分隔的資料集鍵名（預設：`forecast_hourly,forecast_daily,observed,aq,alerts,risk`）
  - 可用鍵：`forecast_hourly` | `forecast_daily` | `observed` | `aq` | `marine` | `alerts` | `risk` | `astronomy` | `metar` | `solar` | `environment`
- 其他參數（如 `forecast_days`、`place_id`）會自動轉發給各子請求。

**Response**
- `meta`：`{ lat, lon, include, elapsed_ms, fetched_at }`
- `data`：各成功資料集的 JSON 回應（以鍵名為 key）
- `errors`（可選）：各失敗資料集的錯誤訊息（`{ status, error }`）

每個資料集獨立失敗，不影響其他資料集。

## API：Indices（複合指數）

### `GET /wx-indices`
基於 Open-Meteo 即時預報計算複合天氣指數（無需 API key 費用）。

**Query Params**
- `lat`, `lon`：必填

**Response**
- `meta`：`{ lat, lon, fetched_at, provider }`
- `current`：`{ temp_c, apparent_temp_c, humidity_pct, wind_ms, cloud_pct, uv_index, uv_category, us_aqi, heat_index_c?, wind_chill_c?, frost_risk, heat_risk }`
  - `heat_index_c`：僅在 t ≥ 27°C 時計算（Rothfusz 回歸）
  - `wind_chill_c`：僅在 t ≤ 10°C 且風速 > 1.3 m/s 時計算
  - `frost_risk`：`Low` / `Moderate` / `High`（基於 t ≤ 3°C）
  - `heat_risk`：`Low` / `Moderate` / `High`（基於 t ≥ 33°C）
- `indices`：
  - `comfort`：`{ score: 0–100, label }` — 溫度/濕度/風速三維加權
  - `health`：`{ score: 0–100, label, risks[] }` — 懲罰熱壓力/冷壓力/高濕/高 UV/空污
  - `outdoor`：`{ score: 0–100, label }` — 降水機率/溫度/風/UV 戶外適宜度
  - `energy`：`{ cooling_demand, heating_demand, solar_potential }` — 度日數代理值
- `hourly`：24 小時逐時 `{ time, comfort, outdoor, uv_index, uv_category }`
- `cache-control: public, max-age=900`

## API：Compare（多地比較）

### `GET /wx-compare`
一次請求比較最多 5 個地點的天氣（並行抓取）。

**Query Params**
- `locations`：`lat1,lon1[,label]|lat2,lon2[,label]|...`（pipe 分隔，最多 5 組）
  - 範例：`locations=22.3,114.2,Hong Kong|35.7,139.7,Tokyo|48.9,2.3,Paris`

**Response**
- `meta`：`{ fetched_at, count }`
- `locations[]`：每個地點 `{ label, lat, lon, timezone, current{...}, daily[3]{...} }`
  - `current`：temp_c, apparent_temp_c, humidity_pct, wind_ms, cloud_pct, uv_index, precip_mm, weather_code
  - `daily`：date, t_min_c, t_max_c, precip_sum_mm, precip_prob_max, wind_max_ms, uv_max, sunrise, sunset
- `delta`（前兩個地點的差值）：`{ temp_c, humidity_pct, wind_ms, uv_index, between: [label_a, label_b] }`
- `errors[]`（若部分地點失敗）
- `cache-control: public, max-age=600`

## API：Anomaly（氣候異常偵測）

### `GET /wx-anomaly`
將今日天氣與歷史常態比較，偵測統計異常。

**Query Params**
- `lat`, `lon`：必填

**演算法**
從 Open-Meteo Historical Archive 抓取過去採樣年份（1994/1999/2004/2009/2014/2019/2023）中與今日同一週期（±7 天窗口）的每日資料，計算 μ 與 σ，以 Z-score 判定異常程度。

**Response**
- `meta`：`{ lat, lon, reference_date, historical_years[], historical_window_days, sample_count, fetched_at }`
- `overall_anomaly`：`Normal` / `Slightly anomalous` / `Anomalous` / `Extreme anomaly`
- `max_z_score`：最大 Z-score（跨所有變數）
- `deviations`：各變數 `{ current, normal, deviation, sigma, anomaly }`
  - 變數：`temp_min_c`、`temp_max_c`、`precip_mm`
- `normals`：`{ temp_min_c, temp_max_c, precip_mm, wind_max_ms }`（歷史常態均值）
- `cache-control: public, max-age=3600`（每小時快取，歷史資料不變）

## API：Webhook（事件推送訂閱）

NovaWeather 支援 Webhook 讓你的後端在氣象事件發生時收到 HTTP POST 推送（目前事件：`alert_new`、`risk_high`）。每 5 分鐘由 `pg_cron` 觸發派送。

### `POST /wx-webhook-register`
建立新的 Webhook 訂閱。

**Request Body（JSON）**
- `owner_key`（必填）：訂閱識別金鑰（由你自訂，用於管理自己的訂閱）
- `callback_url`（必填）：接收事件的 HTTPS URL
- `event_types`（可選）：`["alert_new", "risk_high"]`（預設 `["alert_new"]`）
- `lat`, `lon`（可選）：地理中心點；設定後只派送該點 `radius_km` 範圍內的事件
- `radius_km`（可選）：1–5000，預設 50
- `secret`（可選）：HMAC-SHA256 簽名密鑰，設定後派送時在 `X-WxHook-Signature: sha256=<hex>` header 附上

**Response 201**
```json
{
  "ok": true,
  "subscription": { "id": "uuid", "callback_url": "...", "event_types": [...], "active": true, ... }
}
```
- 每個 `owner_key` 最多 20 個活躍訂閱

### `GET /wx-webhook-register?owner_key=xxx`
列出指定 `owner_key` 的所有訂閱。

**Response**
```json
{ "subscriptions": [...], "count": 2 }
```

### `DELETE /wx-webhook-register?id=xxx&owner_key=xxx`
停用（軟刪除）指定訂閱。

**Response**
```json
{ "ok": true, "message": "Subscription deactivated" }
```

---

### Webhook 派送格式
每次觸發向 `callback_url` 發送 HTTP POST：

```json
{
  "subscription_id": "uuid",
  "api_version": "v1",
  "fired_at": "2026-05-03T00:00:00.000Z",
  "events": [
    {
      "event_type": "alert_new",
      "data": { "id": "...", "source": "NWS", "severity": "Extreme", "headline": "...", ... }
    }
  ]
}
```

**HMAC 驗證**（有設 `secret` 時）
```
X-WxHook-Signature: sha256=<hex-digest>
```
簽名範圍為整個 request body（JSON 字串），使用 `HMAC-SHA256(secret, body)`。

**自動停用規則**：連續失敗 ≥ 10 次的訂閱將自動停用（`active = false`）。

---

### `GET /wx-webhook-dispatch?since_minutes=6`（手動觸發）
手動執行一次派送循環（供測試或補送）。

**Response**
```json
{
  "ok": true,
  "dispatched": 3,
  "checked_subscriptions": 5,
  "new_alerts_found": 2,
  "window_minutes": 6,
  "since": "2026-05-03T...",
  "fired_at": "2026-05-03T..."
}
```

## 維運/排程 API（POST）
以下端點會寫入/清理資料，**請只在安全環境**（Scheduler/後端）以 `service_role` 呼叫。

### 熱點預取
- `POST /wx-refresh-hotspots-hourly`：刷新 `wx_hotspots` 的 hourly forecast
- `POST /wx-refresh-hotspots-daily`：刷新 `wx_hotspots` 的 daily forecast
- `POST /wx-observed-refresh-hotspots`：刷新 `wx_hotspots` 的 observed rolling

> 雲端 `novaweather` 已建立 `pg_cron + pg_net` 排程，會定時呼叫上述 ingestion functions。

### 清理/保留
- `POST /wx-cleanup-expired-cache`：清理 `wx_cache` 過期資料
- `POST /wx-prune-time-series`：修剪 `wx_hourly_series` / `wx_daily_series` 的舊資料
- `POST /wx-alerts-prune`：清理 `wx_alerts` 已過期太久的事件（預設保留 30 天，可傳 `keep_days`）

### 官方警報 ingest
- `POST /wx-alerts-ingest-cap`：從 `wx_alert_feeds` 讀取 CAP/Atom feeds 並寫入 `wx_alerts`（支援 polygon/circle bbox 提取）
- `POST /wx-alerts-ingest-hko`：香港天文台警報 ingest（含 HK bbox）
- `POST /wx-alerts-ingest-smg`：澳門氣象訊號 ingest（含 Macau bbox，僅在有效訊號時插入）
- `POST /wx-alerts-ingest-nws`：美國 NWS GeoJSON 警報 ingest（全美主動警報 + polygon bbox/centroid）

### 空氣質素 ingest
- `POST /wx-refresh-airquality-hotspots`：刷新所有熱點的空氣質素資料（Open-Meteo AQ API）

### 海洋資料 ingest
- `POST /wx-refresh-marine-hotspots`：刷新所有沿海熱點的海洋波浪資料（Open-Meteo Marine API，自動跳過陸地座標）

### METAR 觀測 ingest
- `POST /wx-observed-metar`：刷新 35 個全球優先站 METAR 觀測（NOAA Aviation Weather Center）

### Webhook 派送（排程）
- `GET /wx-webhook-dispatch`：每 5 分鐘由 `pg_cron` 自動觸發；可手動呼叫補送（`?since_minutes=N`）
  - 排程名稱：`novaweather_webhook_dispatch`
- `novaweather_prune_webhook_deliveries`（純 SQL cron）：每天 03:15 清理 7 天前的派送記錄

### 供應商健康度
- `POST /wx-provider-health-refresh`：以 `wx_ingest_runs` 計算近 15 分鐘失敗率/P95 延遲，寫回 `wx_provider_health`

#### Region Code 同步
- `POST /wx-sync-region-codes`：同步 `wx_region_codes`（順序：`wx_locations` 回填 → 自 `wx_hotspots` 以 Open‑Meteo Reverse 補齊全球熱點網格 → 內建 seed）

  **Body（JSON，可選；空 body 亦可，排程常用）**
  - `hotspot_limit`：本次最多處理幾個熱點（1–500，預設 80）
  - `hotspot_concurrency`：並行 reverse 請求數（1–20，預設 8）

  **Response（節錄）**
  - `synced_from_locations`：自 `wx_locations` upsert 筆數
  - `hotspot_sync`：`{ upserted, failed, skipped }`（`skipped` 為該批熱點 geohash 已存在且 `place_id` 以 `hotspot:` 開頭者）
  - `seeded`：種子列數
  - `country_count` / `countries` / `synced_at`

## 一次性工具
### `POST /wx-hotspots-seed-global-cities`
把「全球主要城市」寫入 `wx_hotspots`，讓熱點排程能立即運作。

**Body（JSON）**
- `limit`：50–2000（預設 300）
- `geohash_precision`：5–7（預設 6）

**範例**
```bash
curl -X POST "<BASE>/wx-hotspots-seed-global-cities" \
  -H "Authorization: Bearer <SERVICE_ROLE>" \
  -H "content-type: application/json" \
  -d '{ "limit": 300, "geohash_precision": 6 }'
```

## 錯誤格式（統一）
API 失敗時會回：
```json
{ "error": "Internal error", "detail": "..." }
```

