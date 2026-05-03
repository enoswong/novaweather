# NovaWeather — Supabase 架構與外部資料流 v1.0.0

## 目錄

1. [整體架構概覽](#整體架構概覽)
2. [PostgreSQL 擴充套件](#postgresql-擴充套件)
3. [資料表結構](#資料表結構)
4. [RLS 安全策略](#rls-安全策略)
5. [PostgreSQL 函式（RPC）](#postgresql-函式rpc)
6. [Edge Functions 清單](#edge-functions-清單)
7. [共用模組（_shared）](#共用模組_shared)
8. [外部資料來源與抓取流程](#外部資料來源與抓取流程)
9. [供應商鏈與備援機制](#供應商鏈與備援機制)
10. [pg_cron 排程全覽](#pgcron-排程全覽)
11. [快取策略](#快取策略)
12. [Secrets 管理](#secrets-管理)
13. [資料流程圖](#資料流程圖)

---

## 整體架構概覽

```
外部請求（用戶 / 前端 App）
        │
        ▼
┌─────────────────────────────────┐
│   wx-api-proxy (Edge Function)  │  ← CORS + 白名單路由 + 可選 X-WxApi-Key 認證
└─────────────┬───────────────────┘
              │ 轉發至對應 Function
              ▼
┌──────────────────────────────────────────────────┐
│          業務 Edge Functions（37 端點）            │
│  wx-forecast-hourly / wx-alerts / wx-indices ...  │
└──────────────┬──────────────────┬────────────────┘
               │                  │
       讀取快取  │                  │ 快取 miss → 呼叫外部 API
               ▼                  ▼
┌──────────────────┐    ┌────────────────────────────────────┐
│  PostgreSQL DB   │    │  外部天氣 API 供應商                  │
│  (Supabase)      │◄───│  Open-Meteo / Met Norway (Yr.no)   │
│  18 張資料表      │    │  Pirate Weather / WeatherAPI        │
│  (2 張月分區)     │    │  Tomorrow.io / OpenWeather          │
└──────────────────┘    │  NOAA / HKO / NWS / SMG / Nominatim│
        ▲               └────────────────────────────────────┘
        │
┌────────────────────────┐
│  pg_cron 排程           │  ← 20 個定時任務（熱點預取 + alerts ingest + webhook queue + 清理）
│  (20 jobs)             │
└────────────────────────┘
```

---

## PostgreSQL 擴充套件

| 擴充套件 | 用途 |
|---|---|
| `pgcrypto` | `gen_random_uuid()` UUID 主鍵生成 |
| `postgis` | `geography` 欄位、`ST_DWithin`、`ST_MakePoint` 地理空間查詢 |
| `pg_net` | 從 pg_cron 觸發 HTTP POST（呼叫 Edge Functions） |
| `pg_cron` | 定時排程任務（20 個 jobs） |

啟用方式（已寫入 migrations）：

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;
```

---

## 資料表結構

### 1. `wx_locations` — 地點索引

地名 / 座標的正規化索引表，儲存 Open-Meteo Geocoding 回傳的地點資訊。

```
wx_locations
├── id              UUID PK  (gen_random_uuid)
├── lat             DOUBLE PRECISION  NOT NULL
├── lon             DOUBLE PRECISION  NOT NULL
├── geohash         TEXT  NOT NULL  (UNIQUE)
├── timezone        TEXT  NOT NULL
├── country_code    TEXT  NULL
├── admin1          TEXT  NULL       ← 省/州
├── admin2          TEXT  NULL       ← 縣/市
├── admin3          TEXT  NULL
├── admin4          TEXT  NULL
├── locality        TEXT  NULL       ← 城鎮/鄉村
├── name            TEXT  NULL
├── place_id        TEXT  NULL  (UNIQUE where not null)
├── created_at      TIMESTAMPTZ  DEFAULT now()
└── updated_at      TIMESTAMPTZ  DEFAULT now()
```

**索引**

| 索引名稱 | 欄位 | 說明 |
|---|---|---|
| `wx_locations_geohash_uq` | `geohash` | 唯一索引 |
| `wx_locations_lat_lon_idx` | `lat, lon` | 座標查詢 |
| `wx_locations_place_id_uq` | `place_id` (partial) | 精準位置查詢 |
| `wx_locations_country_admin1_idx` | `country_code, admin1` | 國家/省份篩選 |
| `wx_locations_country_admin12_idx` | `country_code, admin1, admin2` | 細化行政區篩選 |

---

### 2. `wx_hotspots` — 熱點表

排程預取的目標座標集合，cron 會定期刷新這些點的天氣資料。

```
wx_hotspots
├── geohash                  TEXT  PK
├── lat                      DOUBLE PRECISION  NOT NULL
├── lon                      DOUBLE PRECISION  NOT NULL
├── priority                 INTEGER  NOT NULL  DEFAULT 0
├── last_refresh_hourly_at   TIMESTAMPTZ  NULL
├── last_refresh_daily_at    TIMESTAMPTZ  NULL
└── created_at               TIMESTAMPTZ  DEFAULT now()
```

**索引**

| 索引名稱 | 欄位 | 說明 |
|---|---|---|
| `wx_hotspots_priority_desc_idx` | `priority DESC, created_at DESC` | 高優先度先取 |

> 熱點來源：`wx-hotspots-seed-global-cities`（一次性工具）插入全球 300+ 主要城市，
> 之後由各 ingest 函式動態補充。

---

### 3. `wx_cache` — API 回應快取

直接快取 Edge Function 的 JSON 回應 payload，避免重複呼叫上游 API。

```
wx_cache
├── cache_key   TEXT  PK   ← "{geohash}|{endpoint}|{param1=v1}|..."（已排序，v1.0.0 起 provider 不入鍵）
├── geohash     TEXT  NOT NULL
├── endpoint    TEXT  NOT NULL
├── params      JSONB  NOT NULL  DEFAULT '{}'
├── payload     JSONB  NOT NULL  ← 完整 API 回應
├── fetched_at  TIMESTAMPTZ  NOT NULL
└── expires_at  TIMESTAMPTZ  NOT NULL
```

**索引**

| 索引名稱 | 欄位 | 說明 |
|---|---|---|
| `wx_cache_geohash_endpoint_idx` | `geohash, endpoint` | 快取查詢 |
| `wx_cache_expires_at_idx` | `expires_at` | 清理過期 |

**cache_key 生成規則（v1.0.0）**（`_shared/wx/storage.ts`）

```
geohash|endpoint|param1=val1|param2=val2  (params 按字母排序)

變更：
  - provider 欄位不再進入 cache_key（存於 payload.meta）
  - hours 量化至 [24, 48, 72, 120, 168]（normalizeHours）

範例（v1.0.0）：
  wei3|forecast_hourly|hours=72
  （hours=50 → 量化為 72，不因請求差異產生碎片快取）
```

---

### 4. `wx_hourly_series` — 小時級時間序列（月分區）

儲存來自各供應商的小時級預報/觀測資料，支援多供應商並存。**v1.0.0 起轉換為 RANGE 月分區（按 valid_time）。**

```
wx_hourly_series  ← 分區父表（RANGE by valid_time）
├── geohash       TEXT  NOT NULL
├── valid_time    TIMESTAMPTZ  NOT NULL  ← 分區鍵
├── kind          TEXT  NOT NULL  CHECK ('observed' | 'forecast')
├── temp_c        DOUBLE PRECISION  NULL
├── feels_like_c  DOUBLE PRECISION  NULL
├── humidity_pct  DOUBLE PRECISION  NULL
├── dewpoint_c    DOUBLE PRECISION  NULL
├── pressure_hpa  DOUBLE PRECISION  NULL
├── wind_ms       DOUBLE PRECISION  NULL
├── wind_dir_deg  DOUBLE PRECISION  NULL
├── gust_ms       DOUBLE PRECISION  NULL
├── precip_mm     DOUBLE PRECISION  NULL
├── precip_prob   DOUBLE PRECISION  NULL   ← 0.0–1.0
├── snow_mm       DOUBLE PRECISION  NULL
├── cloud_pct     DOUBLE PRECISION  NULL
├── visibility_m  DOUBLE PRECISION  NULL
├── uv_index      DOUBLE PRECISION  NULL
├── provider      TEXT  NOT NULL
├── fetched_at    TIMESTAMPTZ  NOT NULL
└── confidence    DOUBLE PRECISION  NULL   ← 0.0–1.0

PK: (geohash, valid_time, kind, provider)  ← 已包含分區鍵，天然相容
```

**子分區**

| 分區名稱 | 範圍 |
|---|---|
| `wx_hourly_series_2026_04` | 2026-04-01 – 2026-05-01 |
| `wx_hourly_series_2026_05` | 2026-05-01 – 2026-06-01 |
| `wx_hourly_series_2026_06` | 2026-06-01 – 2026-07-01 |
| `wx_hourly_series_2026_07` | 2026-07-01 – 2026-08-01 |
| `wx_hourly_series_2026_08` | 2026-08-01 – 2026-09-01 |
| `wx_hourly_series_2026_09` | 2026-09-01 – 2026-10-01 |
| `wx_hourly_series_default` | DEFAULT（超範圍承接） |

**索引**

| 索引名稱 | 欄位 |
|---|---|
| `wx_hourly_series_p_geohash_time_desc_idx` | `geohash, valid_time DESC` |
| `wx_hourly_series_p_kind_idx` | `kind` |

---

### 5. `wx_daily_series` — 日級時間序列

```
wx_daily_series
├── geohash          TEXT  NOT NULL
├── date             DATE  NOT NULL
├── t_min_c          DOUBLE PRECISION  NULL
├── t_max_c          DOUBLE PRECISION  NULL
├── precip_sum_mm    DOUBLE PRECISION  NULL
├── precip_prob_max  DOUBLE PRECISION  NULL
├── wind_max_ms      DOUBLE PRECISION  NULL
├── uv_max           DOUBLE PRECISION  NULL
├── provider         TEXT  NOT NULL
├── fetched_at       TIMESTAMPTZ  NOT NULL
└── confidence       DOUBLE PRECISION  NULL

PK: (geohash, date, provider)
```

**索引**

| 索引名稱 | 欄位 |
|---|---|
| `wx_daily_series_geohash_date_desc_idx` | `geohash, date DESC` |

---

### 6. `wx_alerts` — 官方警報

儲存來自 CAP/HKO/SMG/NWS 等官方來源的警報，支援 PostGIS 地理幾何查詢。

```
wx_alerts
├── id                UUID  PK  (gen_random_uuid)
├── source            TEXT  NOT NULL      ← 'HKO' | 'NWS' | 'SMG' | 'CAP' | ...
├── severity          TEXT  NOT NULL
│                     CHECK ('info'|'yellow'|'orange'|'red'|'emergency')
├── title             TEXT  NOT NULL
├── description       TEXT  NULL
├── starts_at         TIMESTAMPTZ  NULL
├── ends_at           TIMESTAMPTZ  NULL
├── bbox              JSONB  NULL          ← [lon_min, lat_min, lon_max, lat_max]
├── geohash_prefixes  TEXT[]  NULL
├── raw               JSONB  NULL          ← 原始 payload
├── area              geography(Geometry, 4326)  NULL  ← PostGIS polygon/multipolygon
├── area_center       geography(Point, 4326)  NULL     ← PostGIS centroid
├── country_code      TEXT  NULL
├── region_code       TEXT  NULL
├── event_type        TEXT  NULL
├── ext_id            TEXT  NULL           ← 外部來源 ID（UNIQUE per source）
├── sent_at           TIMESTAMPTZ  NULL
├── updated_at        TIMESTAMPTZ  NULL
└── created_at        TIMESTAMPTZ  DEFAULT now()

UNIQUE: (source, ext_id) where ext_id is not null
```

---

### 7. `wx_alert_feeds` — 警報來源配置

```
wx_alert_feeds
├── id              UUID  PK
├── source          TEXT  NOT NULL
├── country_code    TEXT  NULL
├── region_code     TEXT  NULL
├── url             TEXT  NOT NULL
├── is_enabled      BOOLEAN  NOT NULL  DEFAULT true
├── last_fetched_at TIMESTAMPTZ  NULL
└── created_at      TIMESTAMPTZ  DEFAULT now()
```

---

### 8. `wx_risk_snapshots` — 風險快照

```
wx_risk_snapshots
├── geohash       TEXT  NOT NULL
├── computed_at   TIMESTAMPTZ  NOT NULL
├── window_hours  INTEGER  NOT NULL
├── risk_level    INTEGER  NOT NULL  CHECK (0–3)
└── reasons       JSONB  NOT NULL  DEFAULT '[]'

PK: (geohash, computed_at, window_hours)
```

---

### 9. `wx_ingest_runs` — 資料抓取記錄（月分區）

每次 Edge Function 呼叫外部 API 都會寫一筆記錄，用於可觀測性與熔斷。**v1.0.0 起轉換為 RANGE 月分區（按 finished_at），移除 UUID PK 改用 UNIQUE INDEX。**

```
wx_ingest_runs  ← 分區父表（RANGE by finished_at）
├── id          UUID  NOT NULL  DEFAULT gen_random_uuid()  ← 無 PK，UNIQUE INDEX 替代
├── provider    TEXT  NOT NULL
├── geohash     TEXT  NOT NULL
├── endpoint    TEXT  NOT NULL
├── started_at  TIMESTAMPTZ  DEFAULT now()
├── finished_at TIMESTAMPTZ  NOT NULL  ← 分區鍵
├── latency_ms  INTEGER  NULL
├── status      TEXT  NOT NULL  CHECK ('ok'|'error'|'skipped')
├── http_status INTEGER  NULL
└── error       TEXT  NULL

UNIQUE INDEX: wx_ingest_runs_p_id_uq ON (id)
```

**子分區**

| 分區名稱 | 範圍 |
|---|---|
| `wx_ingest_runs_2026_04` | 2026-04-01 – 2026-05-01 |
| `wx_ingest_runs_2026_05` | 2026-05-01 – 2026-06-01 |
| `wx_ingest_runs_2026_06` | 2026-06-01 – 2026-07-01 |
| `wx_ingest_runs_2026_07` | 2026-07-01 – 2026-08-01 |
| `wx_ingest_runs_2026_08` | 2026-08-01 – 2026-09-01 |
| `wx_ingest_runs_default` | DEFAULT（超範圍承接） |

---

### 10. `wx_provider_health` — 供應商健康度

```
wx_provider_health
├── provider              TEXT  PK
├── failure_rate_15m      NUMERIC  NULL     ← 0.0–1.0
├── p95_latency_ms        INTEGER  NULL
├── circuit_open_until    TIMESTAMPTZ  NULL ← 熔斷開放截止時間（預留）
└── updated_at            TIMESTAMPTZ  DEFAULT now()
```

---

### 11. `wx_region_codes` — 國家/地區代碼映射

```
wx_region_codes
├── id            BIGSERIAL  PK
├── country_code  TEXT  NOT NULL
├── region_code   TEXT  NOT NULL
├── region_name   TEXT  NOT NULL
├── geohash       TEXT  NOT NULL  (UNIQUE)
├── place_id      TEXT  NULL
├── lat           DOUBLE PRECISION  NOT NULL
├── lon           DOUBLE PRECISION  NOT NULL
├── timezone      TEXT  NOT NULL  DEFAULT 'UTC'
├── admin1–4      TEXT  NULL
├── locality      TEXT  NULL
├── name          TEXT  NULL
├── created_at    TIMESTAMPTZ  DEFAULT now()
└── updated_at    TIMESTAMPTZ  DEFAULT now()

UNIQUE: (country_code, region_code)
UNIQUE: (geohash)
```

---

### 12. `wx_region_cache` — 地區 API 快取

```
wx_region_cache
├── cache_key     TEXT  PK
├── country_code  TEXT  NOT NULL
├── region_code   TEXT  NULL
├── granularity   TEXT  NOT NULL
├── payload       JSONB  NOT NULL
├── fetched_at    TIMESTAMPTZ  NOT NULL
└── expires_at    TIMESTAMPTZ  NOT NULL
```

---

### 13. `wx_air_quality_series` — 空氣質素時間序列

```
wx_air_quality_series
├── id                    UUID  PK
├── geohash               CHAR(6)  NOT NULL
├── lat / lon             DOUBLE PRECISION  NOT NULL
├── valid_time            TIMESTAMPTZ  NOT NULL
├── pm10 / pm2_5          DOUBLE PRECISION  NULL (μg/m³)
├── carbon_monoxide       DOUBLE PRECISION  NULL (μg/m³)
├── nitrogen_dioxide      DOUBLE PRECISION  NULL (μg/m³)
├── sulphur_dioxide       DOUBLE PRECISION  NULL (μg/m³)
├── ozone                 DOUBLE PRECISION  NULL (μg/m³)
├── aerosol_optical_depth DOUBLE PRECISION  NULL
├── dust                  DOUBLE PRECISION  NULL (μg/m³)
├── uv_index              DOUBLE PRECISION  NULL
├── uv_index_clear_sky    DOUBLE PRECISION  NULL
├── {6種 pollen}          DOUBLE PRECISION  NULL (grains/m³)
├── us_aqi / european_aqi INTEGER  NULL
├── provider              TEXT  NOT NULL  DEFAULT 'open_meteo'
├── fetched_at            TIMESTAMPTZ  NOT NULL
└── created_at            TIMESTAMPTZ  NOT NULL

UNIQUE: (geohash, valid_time, provider)
```

---

### 14. `wx_metar_observations` — METAR 機場觀測

35 個全球優先站（ICAO 代碼），來自 NOAA Aviation Weather Center。

```
wx_metar_observations
├── id               UUID  PK
├── station_id       TEXT  NOT NULL  ← ICAO 代碼（如 VHHH）
├── geohash / lat / lon / elevation_m  ...
├── observation_time TIMESTAMPTZ  NOT NULL
├── temp_c / dewpoint_c / humidity_pct ...
├── wind_dir_deg / wind_speed_ms / wind_gust_ms ...
├── visibility_m / pressure_hpa / pressure_sea_level_hpa ...
├── cloud_cover_pct / weather_code / weather_desc ...
├── raw_metar        TEXT  NULL
├── fetched_at       TIMESTAMPTZ  DEFAULT now()
└── created_at       TIMESTAMPTZ  DEFAULT now()

UNIQUE: (station_id, observation_time)
```

---

### 15. `wx_marine_series` — 海洋時間序列

```
wx_marine_series
├── id                           UUID  PK
├── geohash / lat / lon          ...
├── valid_time                   TIMESTAMPTZ  NOT NULL
├── wave_height_m / wave_direction_deg / wave_period_s ...
├── wind_wave_{height,direction,period} ...
├── swell_wave_{height,direction,period} ...
├── sea_surface_temperature_c    DOUBLE PRECISION  NULL
├── ocean_current_{velocity,direction} ...
├── provider                     TEXT  NOT NULL  DEFAULT 'open_meteo_marine'
├── fetched_at                   TIMESTAMPTZ  NOT NULL
└── created_at                   TIMESTAMPTZ  NOT NULL

UNIQUE: (geohash, valid_time, provider)
```

---

### 16. `wx_webhook_subscriptions` — Webhook 訂閱

```
wx_webhook_subscriptions
├── id              UUID  PK  DEFAULT gen_random_uuid()
├── owner_key       TEXT  NOT NULL
├── callback_url    TEXT  NOT NULL  ← HTTPS only
├── event_types     TEXT[]  NOT NULL  ← ['alert_new', 'risk_high']
├── lat / lon       DOUBLE PRECISION  NULL  ← 地理過濾中心點
├── radius_km       INTEGER  NOT NULL  DEFAULT 50
├── secret          TEXT  NULL  ← HMAC-SHA256 簽名密鑰
├── active          BOOLEAN  NOT NULL  DEFAULT TRUE
├── created_at / updated_at  TIMESTAMPTZ ...
├── last_fired_at   TIMESTAMPTZ  NULL
├── fire_count      INTEGER  NOT NULL  DEFAULT 0
└── failure_count   INTEGER  NOT NULL  DEFAULT 0  ← ≥ 10 → 自動停用
```

---

### 17. `wx_webhook_deliveries` — Webhook 派送記錄

```
wx_webhook_deliveries
├── id               UUID  PK
├── subscription_id  UUID  NOT NULL  FK → wx_webhook_subscriptions(id) ON DELETE CASCADE
├── event_type       TEXT  NOT NULL
├── payload          JSONB  NOT NULL
├── status_code      INTEGER  NULL
├── success          BOOLEAN  NOT NULL  DEFAULT FALSE
├── attempted_at     TIMESTAMPTZ  NOT NULL  DEFAULT NOW()
└── duration_ms      INTEGER  NULL
```

---

### 18. `wx_webhook_queue` — Webhook 非同步佇列（v1.0.0 新增）

Fanout 寫入佇列，Worker 認領並發送，實現非同步解耦。

```
wx_webhook_queue
├── id              UUID  PK  DEFAULT gen_random_uuid()
├── subscription_id UUID  NOT NULL  FK → wx_webhook_subscriptions(id) ON DELETE CASCADE
├── payload         JSONB  NOT NULL
├── status          TEXT  NOT NULL  DEFAULT 'pending'
│                   CHECK ('pending'|'sending'|'done'|'failed')
├── dedup_key       TEXT  UNIQUE    ← subscription_id:sorted_alert_ids（防重複入列）
├── scheduled_at    TIMESTAMPTZ  NOT NULL  DEFAULT NOW()
├── claimed_at      TIMESTAMPTZ  NULL      ← Worker 認領時間
├── done_at         TIMESTAMPTZ  NULL
├── attempts        INTEGER  NOT NULL  DEFAULT 0
└── last_error      TEXT  NULL
```

**索引**

| 索引名稱 | 欄位 |
|---|---|
| `wx_webhook_queue_pending_idx` | `status, scheduled_at` WHERE status='pending' |
| `wx_webhook_queue_sub_idx` | `subscription_id` |

---

## RLS 安全策略

所有資料表均啟用 Row Level Security。

### 公開讀取（`anon` + `authenticated`）

| 資料表 | 說明 |
|---|---|
| `wx_locations` | 地點索引公開讀 |
| `wx_cache` | API 快取公開讀 |
| `wx_hourly_series` | 小時序列公開讀（含子分區） |
| `wx_daily_series` | 日序列公開讀 |
| `wx_alerts` | 警報公開讀 |
| `wx_risk_snapshots` | 風險快照公開讀 |
| `wx_ingest_runs` | 可觀測性公開讀 |
| `wx_provider_health` | 供應商健康公開讀 |
| `wx_hotspots` | 熱點公開讀 |
| `wx_alert_feeds` | Feed 配置公開讀 |
| `wx_air_quality_series` | AQ 資料公開讀 |
| `wx_metar_observations` | METAR 公開讀 |
| `wx_marine_series` | 海洋資料公開讀 |

### 受限寫入（`service_role` only）

| 資料表 |
|---|
| `wx_air_quality_series` |
| `wx_metar_observations` |
| `wx_marine_series` |
| `wx_webhook_subscriptions` |
| `wx_webhook_deliveries` |
| `wx_webhook_queue` |

> 分區表（`wx_hourly_series`、`wx_ingest_runs`）的 RLS policy 套用於父表，自動繼承至所有子分區。

---

## PostgreSQL 函式（RPC）

### `wx_alerts_nearby(lat, lon, radius_m)`

PostGIS 地理空間 RPC，查詢有效期內且在指定範圍內的警報。

```sql
CREATE OR REPLACE FUNCTION public.wx_alerts_nearby(
  in_lat DOUBLE PRECISION,
  in_lon DOUBLE PRECISION,
  in_radius_m INTEGER DEFAULT 50000
) RETURNS TABLE (id, source, severity, title, description, starts_at, ends_at)
...
GRANT EXECUTE ON FUNCTION wx_alerts_nearby TO anon, authenticated;
```

### `wx_claim_webhook_queue(batch_size)` — v1.0.0 新增

原子性認領待發送 webhook 任務（`FOR UPDATE SKIP LOCKED`，防止多 Worker 重複處理）。

```sql
CREATE OR REPLACE FUNCTION public.wx_claim_webhook_queue(
  batch_size INTEGER DEFAULT 50
) RETURNS TABLE (id UUID, subscription_id UUID, payload JSONB, attempts INTEGER)
LANGUAGE SQL SECURITY DEFINER ...
$$
  UPDATE public.wx_webhook_queue q
  SET status='sending', claimed_at=NOW(), attempts=q.attempts+1
  WHERE q.id IN (
    SELECT wq.id FROM public.wx_webhook_queue wq
    WHERE wq.status='pending'
    ORDER BY wq.scheduled_at
    LIMIT batch_size
    FOR UPDATE SKIP LOCKED
  )
  RETURNING q.id, q.subscription_id, q.payload, q.attempts;
$$;

GRANT EXECUTE ON FUNCTION wx_claim_webhook_queue(INTEGER) TO service_role;
```

---

## Edge Functions 清單

所有 Function 以 Deno/TypeScript 撰寫，部署在 Supabase Edge Functions（全球分散式）。

### 公開 API Functions

| Function | HTTP Methods | 說明 |
|---|---|---|
| `wx-api-proxy` | GET/POST/DELETE/OPTIONS | CORS 代理 + 白名單路由 + 可選 X-WxApi-Key 認證 |
| `wx-geo-forward` | GET | 地名搜尋 |
| `wx-geo-reverse` | GET | 座標反查 |
| `wx-forecast-hourly` | GET | 小時預報（地理路由供應商） |
| `wx-forecast-daily` | GET | 日級預報（地理路由供應商） |
| `wx-observed-now` | GET | 即時觀測 |
| `wx-alerts` | GET | 附近警報 |
| `wx-risk` | GET | 風險評估 |
| `wx-environment-timeline` | GET | 環境時間軸（含 minutely_15 nowcast） |
| `wx-country-today` | GET | 國家今日 |
| `wx-region` | GET | 單一地區 |
| `wx-region-coverage` | GET | 覆蓋健康 |
| `wx-air-quality` | GET | 空氣質素 |
| `wx-observed-metar` | GET | METAR 查詢 |
| `wx-status` | GET | 服務健康 |
| `wx-marine` | GET | 海洋預報 |
| `wx-solar` | GET | 太陽輻射 |
| `wx-historical` | GET | 歷史存檔 |
| `wx-astronomy` | GET | 天文曆 |
| `wx-bundle` | GET | 聚合請求 |
| `wx-indices` | GET | 複合指數 |
| `wx-compare` | GET | 多地比較 |
| `wx-anomaly` | GET | 異常偵測 |
| `wx-webhook-register` | GET/POST/DELETE | Webhook 訂閱管理 |

### 排程 / 維運 Functions（service_role 呼叫）

| Function | 說明 |
|---|---|
| `wx-refresh-hotspots-hourly` | 熱點 hourly forecast 刷新 |
| `wx-refresh-hotspots-daily` | 熱點 daily forecast 刷新 |
| `wx-observed-refresh-hotspots` | 熱點 observed rolling 刷新 |
| `wx-cleanup-expired-cache` | 清理 wx_cache 過期記錄 |
| `wx-prune-time-series` | 修剪舊 wx_hourly_series 資料 |
| `wx-alerts-prune` | 清理過期警報 |
| `wx-alerts-ingest-cap` | CAP/Atom feeds ingest |
| `wx-alerts-ingest-hko` | 香港天文台警報 ingest |
| `wx-alerts-ingest-smg` | 澳門氣象訊號 ingest |
| `wx-alerts-ingest-nws` | 美國 NWS GeoJSON ingest |
| `wx-refresh-airquality-hotspots` | 空氣質素熱點刷新 |
| `wx-refresh-marine-hotspots` | 海洋資料熱點刷新 |
| `wx-observed-metar`（POST） | METAR 觀測刷新（35 站） |
| `wx-provider-health-refresh` | 供應商健康度計算 |
| `wx-sync-region-codes` | Region code 同步 |
| `wx-webhook-fanout` | 警報→queue 寫入（v1.0.0 新增） |
| `wx-webhook-worker` | queue→HTTP 發送（v1.0.0 新增） |
| `wx-hotspots-seed-global-cities` | 全球城市種子（一次性） |

> `wx-webhook-dispatch` 已在 v1.0.0 廢棄，由 `wx-webhook-fanout` + `wx-webhook-worker` 取代。

---

## 共用模組（_shared）

所有 Edge Functions 共用 `supabase/functions/_shared/wx/` 下的模組：

### `types.ts` — 型別定義

```typescript
export type WxProvider =
  | "auto" | "open_meteo"
  | "met_norway"       // v1.0.0 新增：Yr.no (ECMWF)
  | "pirate_weather"   // v1.0.0 新增：Dark Sky-compatible
  | "nova_ensemble"    // v1.0.0 新增：多供應商加權平均（保留）
  | "weatherapi" | "tomorrow_io" | "openweather";

// v1.0.0 新增：minutely_15 nowcast 點
export type WxNowcastPoint = {
  valid_time:   string;          // ISO 8601 UTC
  precip_mm_h:  number | null;   // mm/h（15min raw × 4）
  precip_prob:  number | null;   // 0–1
  wind_ms:      number | null;
  gust_ms:      number | null;
};
```

### `provider_chain.ts` — 供應商鏈（v1.0.0 地理路由）

```typescript
// EU 43 國優先 Met Norway；US/CA 有 Key 優先 Pirate Weather；其餘走預設
export function geoRoutedPriority(country_code?: string | null):
  Exclude<WxProvider, "auto" | "nova_ensemble">[]

export function defaultProviderPriority():
  ["open_meteo", "weatherapi", "tomorrow_io", "openweather"]
```

### `storage.ts` — 資料寫入（v1.0.0 快取鍵更新）

- `normalizeHours(hours)` — 量化至 [24, 48, 72, 120, 168]
- `buildCacheKey({geohash, endpoint, params})` — provider 不入鍵，hours 已量化
- `tryReadCache() / writeCache()` — 讀寫 `wx_cache`
- `upsertHourlySeries() / upsertDailySeries()` — 寫入時間序列
- `recordIngestRun()` — 寫入 `wx_ingest_runs`

### `providers/` — 供應商 Adapters

| 檔案 | 供應商 | API Key 需求 |
|---|---|---|
| `open_meteo.ts` | Open-Meteo + minutely_15 nowcast | ❌ 免費 |
| `met_norway.ts` | Met Norway (Yr.no) — ECMWF 模型 | ❌ 免費（需 User-Agent） |
| `pirate_weather.ts` | Pirate Weather — Dark Sky-compatible | ✅ `PIRATE_WEATHER_API_KEY` |
| `weatherapi.ts` | WeatherAPI.com | ✅ `WEATHER_API_KEY` |
| `tomorrow_io.ts` | Tomorrow.io | ✅ `TOMORROW_IO_API_KEY` |
| `openweather.ts` | OpenWeatherMap | ✅ `OPENWEATHER_API_KEY` |

---

## 外部資料來源與抓取流程

### 來源一：Open-Meteo（主力預報 + Nowcast）

**用於**：`wx-forecast-hourly`, `wx-forecast-daily`, `wx-environment-timeline`, `wx-indices`, `wx-compare`, `wx-anomaly`

- 免費，無需 API Key，支援全球座標
- v1.0.0 新增 `minutely_15` 參數（`fetchOpenMeteoNowcast`）：降水 mm/15min → mm/h（×4），降水機率 0–100 → 0–1

### 來源二：Met Norway Yr.no（EU 地理路由優先）

**用於**：EU 43 國的 `wx-forecast-hourly` / `wx-forecast-daily`（provider=auto）

```
URL: https://api.met.no/weatherapi/locationforecast/2.0/compact
- 免費，無需 API Key
- 必填 User-Agent: "NovaWeather/1.0 (contact@example.com)"
- 回傳 UTC ISO 8601 時間戳
- ECMWF 模型，confidence: 0.85
- 日資料從 6h 時段聚合（next_6_hours details）
```

### 來源三：Pirate Weather（NA 地理路由優先）

**用於**：US/CA 的 `wx-forecast-hourly` / `wx-forecast-daily`（provider=auto，有 Key 時）

```
URL: https://api.pirateweather.net/forecast/{key}/{lat},{lon}?units=si
- 需 PIRATE_WEATHER_API_KEY
- Dark Sky-compatible JSON 格式
- Unix timestamp → UTC ISO 8601
- SI 單位（visibility km→m ×1000；precipitation intensity mm/h）
- confidence: 0.8
```

### 來源四：WeatherAPI / Tomorrow.io / OpenWeatherMap（全域備援）

```
供應商優先序（非 EU/NA 地區，或 EU/NA 無對應 Key）：
  open_meteo → weatherapi → tomorrow_io → openweather

所有 fetch 均帶 AbortSignal.timeout(10000)（10s 硬超時）
```

### 其餘來源：Open-Meteo AQ / Marine / Solar、NOAA METAR、HKO / SMG / NWS / CAP

> 詳見各 v0.5.0–v0.9.0 changelog，此處略。

---

## 供應商鏈與備援機制（v1.0.0 地理路由）

```
用戶請求 GET /wx-forecast-hourly?lat=48.8&lon=2.3&provider=auto  (巴黎，FR)
    │
    ▼
[1] 計算 geohash = "u09tvw" ; country_code = "FR"
    │
    ▼
[2] 查詢 wx_cache
    │
    ├── [命中 & 新鮮] ──────────────────────────→ 回傳快取（~5ms）
    │
    └── [未命中 / 過期]
            │
            ▼
[3] geoRoutedPriority("FR") → ["met_norway", "open_meteo", ...]
    │
    ▼
[4] 嘗試 Met Norway（EU 優先，無 Key）
    │
    ├── [成功] → 寫 wx_cache + wx_hourly_series → 回傳
    │
    └── [失敗]
            │
            ▼
[5] 嘗試 Open-Meteo → WeatherAPI → Tomorrow.io → OpenWeather（依序 fallback）
```

---

## pg_cron 排程全覽

20 個排程任務，全部透過 `pg_net.http_post()` 呼叫 Edge Functions（純 SQL 任務直接執行）：

| 排程名稱 | Cron 表達式 | 說明 |
|---|---|---|
| `novaweather_refresh_hotspots_hourly` | `*/30 * * * *` | 熱點 hourly 預取 |
| `novaweather_refresh_hotspots_daily` | `0 */6 * * *` | 熱點 daily 預取 |
| `novaweather_observed_refresh_hotspots` | `*/15 * * * *` | 熱點 observed 更新 |
| `novaweather_alerts_ingest_cap` | `*/10 * * * *` | CAP Atom feeds |
| `novaweather_alerts_ingest_hko` | `*/5 * * * *` | 香港天文台警報 |
| `novaweather_alerts_ingest_smg` | `*/10 * * * *` | 澳門氣象訊號 |
| `novaweather_alerts_ingest_nws` | `*/10 * * * *` | NWS GeoJSON 警報 |
| `novaweather_provider_health_refresh` | `*/5 * * * *` | 供應商健康度 |
| `novaweather_cleanup_expired_cache` | `17 * * * *` | 清理過期快取 |
| `novaweather_prune_time_series` | `41 2 * * *` | 修剪舊時間序列 |
| `novaweather_alerts_prune` | `53 2 * * *` | 清理過期警報 |
| `novaweather_refresh_airquality_hotspots` | `5 */3 * * *` | AQ 熱點更新 |
| `novaweather_observed_metar` | `15,45 * * * *` | METAR 刷新（35 站） |
| `novaweather_refresh_marine_hotspots` | `35 */6 * * *` | 海洋熱點更新 |
| `novaweather_sync_region_codes` | `*/30 * * * *` | Region code 同步 |
| `novaweather_webhook_fanout` | `*/5 * * * *` | 警報→queue 寫入（v1.0.0） |
| `novaweather_webhook_worker` | `* * * * *` | queue→HTTP 發送（v1.0.0） |
| `novaweather_prune_webhook_queue` | `37 3 * * *` | 清理 7 天前 done/failed 佇列記錄（純 SQL） |
| `novaweather_prune_webhook_deliveries` | `15 3 * * *` | 清理 7 天前 delivery 記錄（純 SQL） |
| `novaweather_prune_ingest_runs` | `23 3 * * *` | 清理 7 天前 ingest_runs 記錄（純 SQL） |

> `novaweather_webhook_dispatch` 已移除（v0.9.0→v1.0.0）。

---

## 快取策略

| 資料類型 | TTL | 快取表 | 說明 |
|---|---|---|---|
| 預報資料（hourly/daily） | 30 分鐘 | `wx_cache` | 一般預報快取 |
| 觀測資料（observed） | 15 分鐘 | `wx_cache` | 資料更新較快 |
| 警報資料 | 5 分鐘 | `wx_cache` | 警報需快速更新 |
| **Nowcast（minutely_15）** | **5 分鐘** | **`wx_cache`** | **v1.0.0 新增** |
| 地區資料（region/country） | 30 分鐘 | `wx_region_cache` | 批量地區快取 |
| 歷史資料（historical） | 1 小時 | HTTP `cache-control` | 歷史不變，可用 CDN |
| 異常偵測（anomaly） | 1 小時 | HTTP `cache-control` | 歷史常態不變 |
| 複合指數（indices） | 15 分鐘 | HTTP `cache-control` | 指數計算快取 |
| 多地比較（compare） | 10 分鐘 | HTTP `cache-control` | 並行資料快取 |

---

## Secrets 管理

所有 API Key 和敏感資訊存放於 **Supabase Secrets / Vault**，在 Edge Function 中透過 `Deno.env.get()` 讀取：

| Secret 名稱 | 用途 | 版本 |
|---|---|---|
| `WEATHER_API_KEY` | WeatherAPI.com 備援供應商 | v0.2 |
| `TOMORROW_IO_API_KEY` | Tomorrow.io 備援供應商 | v0.2 |
| `OPENWEATHER_API_KEY` | OpenWeatherMap 備援供應商 | v0.2 |
| `PIRATE_WEATHER_API_KEY` | Pirate Weather（US/CA 地理路由）| **v1.0.0 新增** |
| `WX_PUBLIC_API_KEY` | 可選 API Key 認證（X-WxApi-Key header） | **v1.0.0 新增** |
| `SUPABASE_SERVICE_ROLE_KEY` | 由 Supabase 平台自動注入 | v0.2 |
| `SUPABASE_URL` | 由 Supabase 平台自動注入 | v0.2 |

> **禁止**在程式碼、前端、公開文件中硬編碼任何 API Key。
> Met Norway 無需 API Key，但需在 HTTP Header 設定合規 User-Agent。

---

## 資料流程圖

### 地理路由供應商選擇（v1.0.0）

```
用戶請求（provider=auto）
    │
    ▼
geoRoutedPriority(country_code)
    ├── EU 43 國 → [met_norway, open_meteo, weatherapi, tomorrow_io, openweather]
    ├── US / CA (有 PIRATE_WEATHER_API_KEY) → [pirate_weather, open_meteo, ...]
    └── 其他 → [open_meteo, weatherapi, tomorrow_io, openweather]
```

### Webhook 非同步佇列流程（v1.0.0）

```
[每 5 分鐘] pg_cron → wx-webhook-fanout
    ├── 查詢 wx_active_alerts（since = now - 6min）
    ├── 對每個匹配訂閱：
    │     dedup_key = sub_id + ':' + sorted(alert_ids)
    │     INSERT INTO wx_webhook_queue ON CONFLICT (dedup_key) DO NOTHING
    └── 回傳 queued 數量

[每 1 分鐘] pg_cron → wx-webhook-worker
    ├── RPC wx_claim_webhook_queue(50) → FOR UPDATE SKIP LOCKED
    ├── 批量查詢 wx_webhook_subscriptions（避免 N+1）
    ├── 並行 HTTP POST（8s timeout）
    │     ├── 成功 → status='done'
    │     └── 失敗 → status='pending'（retry），指數退避（attempts × 60s）
    │           ├── attempts > 5 → status='failed'（永久失敗）
    │           └── failure_count ≥ 10 → subscription.active=FALSE（停用）
    ├── INSERT wx_webhook_deliveries（投遞日誌）
    └── UPDATE wx_webhook_subscriptions（fire_count / failure_count）
```

### Nowcasting 流程（v1.0.0）

```
GET /wx-environment-timeline?lat=22.3&lon=114.2&minute_window=60
    │
    ▼
Promise.all([
  fetchOpenMeteoNowcast(lat, lon, 60),  ← minutely_15，最多 12 步（3h）
  readDB(geohash, observed, hourly)     ← 現有流程
])
    │
    ▼
buildMinuteSeries(nowcastPoints, observed, hourly[0])
    ├── [nowcastPoints >= 2] 真實 15min 降水/風速，1min 線性插值
    └── [無 nowcast]          線性估算 (fallback，保留 v0.9.0 行為)
```

---

## Migration 歷史

| 版本 | Migration 檔案 | 內容 |
|---|---|---|
| v0.2.5 | `20260430150000_init_wx_schema.sql` | 基礎 Schema（8 張表） |
| v0.2.5 | `20260430151000_init_wx_rls.sql` | RLS 安全策略 |
| v0.2.5 | `20260430152000_add_wx_hotspots.sql` | wx_hotspots |
| v0.3.x | `20260501021000_wx_locations_place_id.sql` | place_id 欄位 |
| v0.5.0 | `20260501022000_wx_alerts_nearby_bbox_rpc.sql` | RPC |
| v0.5.0 | `20260501022500_wx_locations_admin34.sql` | admin3/4/locality |
| v0.5.0 | `20260501023000_wx_cloud_sync_and_cron.sql` | PostGIS + alerts + 10 cron |
| v0.5.0 | `20260501024000_secure_wx_alerts_nearby_search_path.sql` | RPC 安全修正 |
| v0.4.x | `20260501050000_add_region_mapping_and_cache.sql` | wx_region_codes + wx_region_cache |
| v0.4.x | `20260501052000_schedule_region_code_sync.sql` | region sync cron |
| v0.5.0 | `20260502000000_add_air_quality_metar_nws.sql` | wx_air_quality_series + wx_metar_observations + NWS |
| v0.6.0 | `20260502010000_add_marine_series.sql` | wx_marine_series |
| v0.9.0 | `20260503010000_add_webhook_subscriptions.sql` | wx_webhook_subscriptions + wx_webhook_deliveries |
| **v1.0.0** | `20260503040000_webhook_queue_and_fanout.sql` | wx_webhook_queue + wx_claim_webhook_queue() RPC + fanout/worker cron |
| **v1.0.0** | `20260503050000_partition_ingest_runs.sql` | wx_ingest_runs 月分區（RANGE by finished_at） |
| **v1.0.0** | `20260503060000_partition_hourly_series.sql` | wx_hourly_series 月分區（RANGE by valid_time） |
