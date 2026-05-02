## v0.9.0 (2026-05-03)
### Phase D — Differentiation: Webhook Push System

**New Features**
- `POST /wx-webhook-register`: register a Webhook subscription to receive weather event pushes.
  - `owner_key`: caller-managed identifier for listing/deleting own subscriptions.
  - `callback_url`: HTTPS endpoint that receives POST events (must use HTTPS).
  - `event_types`: `["alert_new", "risk_high"]` (default: `["alert_new"]`).
  - Optional geo filter: `lat`, `lon`, `radius_km` (1–5000 km, default 50) — only events within radius are pushed.
  - Optional `secret`: when set, every delivery includes `X-WxHook-Signature: sha256=<HMAC-SHA256-hex>` over the raw request body.
  - Per-owner limit: 20 active subscriptions max (429 if exceeded).
- `GET /wx-webhook-register?owner_key=xxx`: list own subscriptions.
- `DELETE /wx-webhook-register?id=xxx&owner_key=xxx`: soft-deactivate a subscription.

- `GET /wx-webhook-dispatch`: cron-driven delivery engine (every 5 min via `novaweather_webhook_dispatch`).
  - Queries `wx_active_alerts` for records `ingested_at ≥ now − window` and fans out to all matching active subscriptions concurrently (`Promise.allSettled`).
  - Each delivery attempt is logged to `wx_webhook_deliveries` (subscription_id, event_type, payload, status_code, success, duration_ms).
  - Auto-deactivates subscriptions with ≥ 10 consecutive failures to prevent runaway delivery attempts.
  - Manual trigger: `?since_minutes=N` (max 60).

**Schema (new tables)**
- `wx_webhook_subscriptions`: subscription registry (owner_key, callback_url, event_types, geo filter, secret, active, fire/failure counts).
- `wx_webhook_deliveries`: per-delivery audit log; pruned after 7 days by `novaweather_prune_webhook_deliveries` cron (03:15 daily).

**pg_cron (2 new jobs, total: 17)**
- `novaweather_webhook_dispatch` — `*/5 * * * *` — dispatch to active subscribers.
- `novaweather_prune_webhook_deliveries` — `15 3 * * *` — delete delivery log rows older than 7 days.

**wx-api-proxy v9** — whitelist expanded with Phase D endpoints: wx-indices, wx-compare, wx-anomaly, wx-webhook-register, wx-webhook-dispatch. CORS now includes DELETE method.

**API test page (index.html) full rewrite** — expanded from 10 endpoints (v0.4.x era) to all 35 active endpoints grouped by category: Geo, Forecast/Observed, Alerts & Risk, Specialized Data (air quality, marine, solar, historical, astronomy, METAR), Analysis (indices, compare, anomaly, bundle), Webhook (list, register, dispatch), Status, Country/Region, and Maintenance POST endpoints. Added lat/lon, locations, bundle include, owner_key, and webhook callback URL inputs to the shared form.

## v0.8.0 (2026-05-02)
### Phase D — Differentiation: Indices, Comparison, Anomaly Detection

**New Features**
- `GET /wx-indices`: composite weather indices derived from Open-Meteo forecast (no API key cost).
  - **Comfort index** (0–100): weighted blend of temperature, humidity, wind proximity to ideal conditions.
  - **Health index** (0–100): penalizes heat stress, cold stress, high humidity, extreme UV, unhealthy AQI. Returns `risks[]` array.
  - **Outdoor index** (0–100): combines precipitation probability, temperature range, wind, UV for activity planning.
  - **Energy index**: `cooling_demand`, `heating_demand` (degree-day proxy), `solar_potential` (High/Moderate/Low).
  - **Derived values**: `apparent_temp_c` (Rothfusz heat index or wind chill), `uv_category`, `frost_risk`, `heat_risk`.
  - **24-hour hourly array**: per-hour comfort + outdoor score + UV category.
  - Also fetches `us_aqi` from Open-Meteo Air Quality API (parallel, best-effort).

- `GET /wx-compare`: side-by-side weather comparison for up to 5 locations in one request.
  - Params: `locations=lat1,lon1[,label]|lat2,lon2[,label]|...` (pipe-separated, max 5).
  - Returns current conditions + 3-day daily forecast per location.
  - `delta` field shows difference between the first two locations (temp_c, humidity_pct, wind_ms, uv_index).

- `GET /wx-anomaly`: statistical anomaly detection vs. 30-year historical normals.
  - Samples 7 historical years (1994–2023), ±7-day window around the same calendar date using Open-Meteo Archive.
  - Computes mean + σ for temp_min/max and precipitation.
  - Per-variable `anomaly` classification: Normal / Slightly anomalous / Anomalous / Extreme anomaly.
  - `overall_anomaly` + `max_z_score` for quick alerting integration.
  - 1-hour cache (`cache-control: public, max-age=3600`).

**wx-api-proxy v8** — whitelist expanded to include wx-indices, wx-compare, wx-anomaly.

## v0.7.0 (2026-05-02)
### Phase C — Engineering Hardening + Bundle Endpoint

**New Features**
- `GET /wx-bundle`: single-request aggregator. Fan-out to any combination of `forecast_hourly`, `forecast_daily`, `observed`, `aq`, `marine`, `alerts`, `risk`, `astronomy`, `metar`, `solar`, `environment` in parallel. Each dataset independently errors without aborting the bundle. 12s per-dataset timeout. `meta.elapsed_ms` shows total wall time.
  - Params: `lat`, `lon`, `include` (comma-separated dataset keys, default: forecast_hourly + forecast_daily + observed + aq + alerts + risk)
  - Extra params (e.g. `forecast_days`, `place_id`) are forwarded to each sub-request.

**Bug Fixes**
- Fix provider fetch timeout: all four weather providers (`open_meteo`, `weatherapi`, `tomorrow_io`, `openweather`) now use `AbortSignal.timeout(10000)` (10s). Previously, hanging upstreams (particularly HK cold-start live-fetch path) would block until the Edge Function execution ceiling, causing 504s.
- `wx-forecast-hourly` and `wx-forecast-daily` redeployed as self-contained functions (v4) with the 10s timeout fix applied.

**wx-api-proxy v7** — added `wx-bundle` to whitelist.

## v0.6.0 (2026-05-02)
### Phase B — Extended Data Dimensions

**New Features**
- `GET /wx-marine`: hourly marine forecast from Open-Meteo Marine API — wave height/direction/period, wind wave, swell wave, sea surface temperature, ocean current velocity/direction. Inland locations return 400. 2h cache via `wx_marine_series`.
- `GET /wx-solar`: hourly + daily solar radiation from Open-Meteo — shortwave/direct/diffuse/DNI/GHI, terrestrial radiation, UV index; daily sunrise/sunset/daylight_duration/sunshine_duration/radiation_sum.
- `GET /wx-historical`: historical weather archive (1940–present) via Open-Meteo Archive API. Params: `start_date`, `end_date` (YYYY-MM-DD), `granularity` (hourly|daily), `variables`. Max 366 days hourly / 3650 days daily. 1h cache.
- `GET /wx-astronomy`: pure-calculation solar/lunar ephemeris (no external API). Returns per-day array of sunrise/sunset, civil/nautical/astronomical twilight (UTC HH:MM), moon phase name + illumination %, UV estimate. Uses Jean Meeus simplified algorithm.
- `POST /wx-refresh-marine-hotspots`: cron maintenance for marine wave data across all coastal hotspots (skips inland 400s).
- `wx-api-proxy` updated to v6 — whitelist expanded to include all Phase A and Phase B endpoints.

**Schema**
- New table: `wx_marine_series` (geohash × valid_time × provider, hourly, RLS).

**Cron** (15 total, +1 new)
- `novaweather_refresh_marine_hotspots`: `35 */6 * * *`

## v0.5.0 (2026-05-02)
### Phase A — Critical Fixes + New Data Dimensions

**Bug Fixes**
- Fix `wx-geo-reverse` 502: replaced non-existent Open-Meteo reverse endpoint with Nominatim (OpenStreetMap). Now returns full address hierarchy (admin1–4, locality, country_code).
- Fix `wx-sync-region-codes` BOOT_ERROR: `_shared/wx/region_codes.ts` was deployed as placeholder. Redeployed with real implementation using Nominatim for hotspot reverse-geocoding (replaces Open-Meteo forward-only API).
- Fix `wx-alerts-ingest-smg`: rewrote to detect actual active signals via HTML keyword parsing; only inserts rows when signals are active; all rows now include Macau bbox + area_center + country_code (geo-filtering now works).
- Fix `wx-alerts-ingest-cap`: added bbox extraction from CAP polygon/circle geometry. All CAP-sourced alerts now populate `bbox` field.
- Disabled broken EnvironmentCanada and oversized MeteoAlarm EU feeds.

**New Features**
- `GET /wx-air-quality`: hourly air quality from Open-Meteo Air Quality API (PM2.5, PM10, CO, NO₂, SO₂, O₃, UV, pollen, US/EU AQI indices).
- `GET /wx-status`: service health page — provider health, ingest freshness, alert geo-coverage stats, region/hotspot counts.
- `GET /wx-observed-metar` / `POST /wx-observed-metar`: METAR surface observations from NOAA Aviation Weather Center for 35 global priority stations. Real-world temperature, wind, pressure, humidity, visibility.
- `POST /wx-alerts-ingest-nws`: NWS GeoJSON API ingest — US national weather alerts with polygon geometry → bbox + centroid. Handles actual/active alerts with auto-prune of expired records.
- `POST /wx-refresh-airquality-hotspots`: cron maintenance for air quality data across all hotspots.
- Region seed expanded from 6 to 15 global cities (added London, Berlin, Paris, Singapore, Sydney, Seoul, Mumbai, Dubai, São Paulo).

**Schema**
- New table: `wx_air_quality_series` (geohash × valid_time × provider, hourly, RLS).
- New table: `wx_metar_observations` (station_id × observation_time, 35 global stations, RLS).

**Cron** (14 total, +3 new)
- `novaweather_alerts_ingest_nws`: `*/10 * * * *`
- `novaweather_refresh_airquality_hotspots`: `5 */3 * * *`
- `novaweather_observed_metar`: `15,45 * * * *`

## v0.4.3 (2026-05-01)
- `wx-sync-region-codes` 來源擴充：`wx_hotspots` 反查映射（Open-Meteo reverse）。
- `wx-region-coverage` 回應新增 `hotspot_count` 與 `source_location_count` 欄位。
- 更新 API 文件版本狀態至 v0.4.3。

## v0.4.2 (2026-05-01)
- 新增 `GET /wx-region-coverage`：回傳 `wx_region_codes` 覆蓋率、seed/location 來源統計與 sample regions。
- 新增 migration：`20260501052000_schedule_region_code_sync.sql`，將 `wx-sync-region-codes` 納入 `pg_cron`（每 30 分鐘）。
- `index.html` 新增 `GET /wx-region-coverage` 測試項。
- `wx-api-proxy` 新增 `wx-region-coverage` 轉發白名單。
- 更新 API/cron 文件與版本狀態。

## v0.4.1 (2026-05-01)
- 新增 shared 模組 `supabase/functions/_shared/wx/region_codes.ts`，集中 `region_code` 生成、seed 區域與映射同步邏輯。
- 新增排程函式 `POST /wx-sync-region-codes`（`supabase/functions/wx-sync-region-codes/index.ts`），同步 `wx_locations -> wx_region_codes` 並補 seed 區域。
- 重構 `wx-country-today`：移除外部 reverse geocoding 依賴，改為使用 shared seed 機制，降低冷啟與外部依賴風險。
- `wx-api-proxy` 與 `index.html` 新增 `wx-sync-region-codes` 測試入口。
- 更新 `docs/cron.md`、`docs/api/novaweather_api_doc.md`、`README.md`、`cursor.md`、`.coding_progress`。

## v0.4.0 (2026-05-01)
- 新增 migration：`20260501050000_add_region_mapping_and_cache.sql`，建立 `wx_region_codes`（region_code 映射）與 `wx_region_cache`（區域查詢快取）。
- 新增 `GET /wx-country-today`：按 `country_code` 回傳該國地區本日資料，支援分頁與 include（summary/risk/alerts）。
- 新增 `GET /wx-region`：以 `country_code + region_code` 查詢地區資料，支援 `granularity=all|minute|hourly|daily`。
- `index.html` 改為 country/region 主流程（新增 country_code、region_code、page、page_size），並支援新 API 實測。
- 更新 API 文件：補齊 Country/Region 新契約與 `place_id` 內部識別說明。

## v0.3.2 (2026-05-01)
- 新增 Supabase Edge Function：`wx-api-proxy`，統一轉發 API 實測頁的 `/wx*` 呼叫並處理 CORS/OPTIONS。
- `index.html` 改為透過 `wx-api-proxy` 請求所有 GET/POST 測試端點，修復 Vercel 前端跨網域 `TypeError: Failed to fetch`。
- 驗證代理轉發：`wx-api-proxy -> wx-risk` 成功回應 200。

## v0.3.1 (2026-05-01)
- 修正 `index.html` GET 請求不再附帶 `content-type: application/json`，避免 CORS preflight 導致瀏覽器 `TypeError: Failed to fetch`。
- 新增「查看 API DOC」按鈕，可直接開啟 `docs/api/novaweather_api_doc.md`。
- 同步更新版本狀態（`README.md`、`cursor.md`、`.coding_progress`）。

## v0.3.0 (2026-05-01)
- 新增 `supabase/functions/wx-environment-timeline/index.ts`：提供 `GET /wx-environment-timeline`，輸出 minute/hourly/daily 與未來數天風險。
- 新增極端天氣判斷：高溫、低溫、乾燥、高濕、強降雨、強風、風暴條件，並加權官方警報輸出 `risk_level` 與 `reasons`。
- 更新 `supabase/functions/_shared/wx/types.ts`：加入環境時間軸回應型別與新增風險原因代碼。
- 更新 `index.html`：每個 API 皆可獨立展開 JSON 輸出，並加入 `wx-environment-timeline` 與 `minute_window` 參數測試。
- 更新 `docs/api/novaweather_api_doc.md`：補齊新 API 契約與 minute/hour/day 資料結構說明。

## v0.2.6 (2026-05-01)
- 新增 `index.html` 詳細 API 實測頁，支援 `/wx/*` 與維運 POST 端點的一鍵測試。
- 新增「按 API 自動刷新」邏輯：優先採用 `cache-control` 與 payload 的 refresh 提示，無資料時回退端點預設頻率。
- 新增即時觀測欄位：HTTP 狀態、延遲、回應大小、最後更新、下次刷新、最後一次 JSON 回應檢視。
- 更新 `README.md`、`cursor.md`、`.coding_progress` 以同步版本狀態與新頁面入口。

## v0.1.0 (2026-04-30)
- 初始化 Supabase 全球天氣後端專案骨架與文件（README/cursor.md/.coding_progress/devlog/error.log）。

## v0.2.0 (2026-04-30)
- 新增 `/wx/*` API 契約文件（SI 單位、缺值策略）與 Edge Functions 共用型別。
- 新增 `wx_*` 資料表 schema、索引與 RLS（公共讀、受控寫）。
- 實作 provider adapters：Open‑Meteo（主力）+ WeatherAPI/Tomorrow/OpenWeather（備援）。
- 實作對外 Edge Functions：`wx-forecast-hourly`、`wx-forecast-daily`、`wx-observed-now`、`wx-alerts`、`wx-risk`。
- 新增排程任務 functions：熱點預取（hourly/daily）+ 快取清理 + 時間序列修剪，並提供 `docs/cron.md`。
- 新增港澳警報 ingest：HKO warnsum + SMG 官網訊號頁最小可用抽取。
- 新增安全文件與 `.env.example`、`.gitignore`（避免 secrets 外流）。

## v0.2.1 (2026-05-01)
- 新增 `wx-hotspots-seed-global-cities`：一次性匯入全球主要城市熱點，讓預取/observed 排程可立即運作。
- 新增 `wx-alerts-prune`：排程清理過期警報，避免官方警報長期累積造成資料膨脹。
- 修正並更新 `docs/cron.md`、`docs/security.md`（清除字串化的換行痕跡，並同步為目前功能現況）。

## v0.2.2 (2026-05-01)
- 新增 `docs/api/novaweather_api_doc.md`：NovaWeather 對外整合用 API 文件（GET `/wx/*` + POST 維運/排程端點）。

## v0.2.3 (2026-05-01)
- 新增 `/wx/geo/*`：`wx-geo-forward`、`wx-geo-reverse`（Open‑Meteo Geocoding），支援以國家/地區細化取得 `place_id` 與精準位置。
- 既有 `/wx/*` GET 端點新增 `place_id`（可選），並在 `meta` 回傳 `country_code/admin1/admin2/name`（若可得）。
- 新增 `wx_alerts_nearby_bbox` RPC（不依賴 PostGIS）並更新 `/wx/alerts` 以 bbox 粗略過濾附近警報。
- 新增 migration：`wx_locations` 加入 `place_id/admin2` 與索引。
- 更新 `docs/api/novaweather_api_doc.md`：補齊 Geo API 與 `place_id` 用法。

## v0.2.4 (2026-05-01)
- `wx_locations` 行政區欄位下沉：新增 `locality/admin3/admin4` 與索引。
- 強化 `/wx/geo/forward`：支援 `q` 使用路徑輸入（例如 `香港/天水圍`、`廣東省/深圳/寶安區`）並用前置段過濾候選。
- `/wx/geo/reverse` 回填更細行政區欄位（若上游提供）。
- 既有 `/wx/*` 端點 meta 擴充：回傳 `admin3/admin4/locality`（若可得）。
- 更新 `docs/api/novaweather_api_doc.md`：補齊路徑輸入與新欄位。

## v0.2.5 (2026-05-01)
- 透過 Supabase MCP 補齊雲端 `novaweather`：啟用 `pg_cron/pg_net` 並建立 10 個 `novaweather_*` cron jobs。
- 補齊雲端 schema：`wx_locations` 精準位置欄位、`wx_alerts` CAP/PostGIS 欄位、`wx_alert_feeds` 與 `wx_alerts_nearby` RPC。
- 部署缺失/更新的 Edge Functions：`wx-geo-forward`、`wx-geo-reverse`、`wx-alerts-ingest-hko`、`wx-prune-time-series`、`wx-refresh-hotspots-hourly`、`wx-observed-now` 等。
- 修正資料一致性：`wx-observed-now` 只讀 `kind=observed`；Open‑Meteo 風速指定為 `m/s`；hourly refresh 改成可分批執行。
- 已 seed 全球 300 個主要城市熱點，並觸發首批 ingestion，雲端已產生 forecast/observed/alerts/health 資料。

