# NovaWeather — Supabase 架構與外部資料流 v0.9.0

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
│   wx-api-proxy (Edge Function)  │  ← CORS + 白名單路由
└─────────────┬───────────────────┘
              │ 轉發至對應 Function
              ▼
┌──────────────────────────────────────────────────┐
│          業務 Edge Functions（35 端點）            │
│  wx-forecast-hourly / wx-alerts / wx-indices ...  │
└──────────────┬──────────────────┬────────────────┘
               │                  │
       讀取快取  │                  │ 快取 miss → 呼叫外部 API
               ▼                  ▼
┌──────────────────┐    ┌──────────────────────────┐
│  PostgreSQL DB   │    │  外部天氣 API 供應商        │
│  (Supabase)      │◄───│  Open-Meteo / WeatherAPI  │
│  15 張資料表      │    │  Tomorrow.io / OpenWeather │
└──────────────────┘    │  NOAA / HKO / NWS / SMG  │
        ▲               └──────────────────────────┘
        │
┌───────────────────┐
│  pg_cron 排程      │  ← 17 個定時任務（熱點預取、alerts ingest、清理）
│  (17 jobs)        │
└───────────────────┘
```

---

## PostgreSQL 擴充套件

| 擴充套件 | 用途 |
|---|---|
| `pgcrypto` | `gen_random_uuid()` UUID 主鍵生成 |
| `postgis` | `geography` 欄位、`ST_DWithin`、`ST_MakePoint` 地理空間查詢 |
| `pg_net` | 從 pg_cron 觸發 HTTP POST（呼叫 Edge Functions） |
| `pg_cron` | 定時排程任務（17 個 jobs） |

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
├── cache_key   TEXT  PK   ← "{geohash}|{endpoint}|{param1=v1}|..."（已排序）
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

**cache_key 生成規則**（`_shared/wx/storage.ts`）

```
geohash|endpoint|param1=val1|param2=val2  (params 按字母排序)
範例：wei3|forecast_hourly|hours=72|provider=open_meteo
```

---

### 4. `wx_hourly_series` — 小時級時間序列

儲存來自各供應商的小時級預報/觀測資料，支援多供應商並存。

```
wx_hourly_series
├── geohash       TEXT  NOT NULL
├── valid_time    TIMESTAMPTZ  NOT NULL
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

PK: (geohash, valid_time, kind, provider)
```

**索引**

| 索引名稱 | 欄位 |
|---|---|
| `wx_hourly_series_geohash_time_desc_idx` | `geohash, valid_time DESC` |
| `wx_hourly_series_kind_idx` | `kind` |

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

**索引**

| 索引名稱 | 欄位 | 說明 |
|---|---|---|
| `wx_alerts_source_starts_at_idx` | `source, starts_at` | 按來源查詢 |
| `wx_alerts_ends_at_idx` | `ends_at` | 過期清理 |
| `wx_alerts_area_gix` | `area` GIST | PostGIS 多邊形查詢 |
| `wx_alerts_area_center_gix` | `area_center` GIST | PostGIS 中心點查詢 |
| `wx_alerts_source_ext_id_uq` | `(source, ext_id)` partial | 去重 |

---

### 7. `wx_alert_feeds` — 警報來源配置

定義各官方警報的 feed URL，ingest function 從此表讀取目標。

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

**預設 Feed 配置**

| source | country_code | URL | 狀態 |
|---|---|---|---|
| `NWS` | US | `https://api.weather.gov/alerts/active.atom` | ✅ 啟用 |
| `NWS_GEOJSON` | US | `https://api.weather.gov/alerts/active?...` | ✅ 啟用 |
| `MeteoAlarm` | EU | `https://feeds.meteoalarm.org/...` | ❌ 停用（體積太大，超時） |
| `EnvironmentCanada` | CA | `https://weather.gc.ca/...` | ❌ 停用（URL 失效） |

HKO / SMG 的 URL 由 `wx-alerts-ingest-hko` / `wx-alerts-ingest-smg` 各自 hardcode，不進此表。

---

### 8. `wx_risk_snapshots` — 風險快照

儲存已計算的風險等級結果，可用於趨勢分析與訓練。

```
wx_risk_snapshots
├── geohash       TEXT  NOT NULL
├── computed_at   TIMESTAMPTZ  NOT NULL
├── window_hours  INTEGER  NOT NULL
├── risk_level    INTEGER  NOT NULL  CHECK (0–3)
└── reasons       JSONB  NOT NULL  DEFAULT '[]'

PK: (geohash, computed_at, window_hours)
```

**索引**

| 索引名稱 | 欄位 |
|---|---|
| `wx_risk_snapshots_geohash_time_desc_idx` | `geohash, computed_at DESC` |

---

### 9. `wx_ingest_runs` — 資料抓取記錄

每次 Edge Function 呼叫外部 API 都會寫一筆記錄，用於可觀測性與熔斷。

```
wx_ingest_runs
├── id               UUID  PK
├── provider         TEXT  NOT NULL
├── geohash          TEXT  NOT NULL
├── endpoint         TEXT  NOT NULL
├── started_at       TIMESTAMPTZ  DEFAULT now()
├── finished_at      TIMESTAMPTZ  NULL
├── latency_ms       INTEGER  NULL
├── status           TEXT  NOT NULL  CHECK ('ok'|'error'|'skipped')
├── http_status      INTEGER  NULL
├── error            TEXT  NULL
└── quota_remaining  INTEGER  NULL
```

**索引**

| 索引名稱 | 欄位 |
|---|---|
| `wx_ingest_runs_provider_started_at_desc_idx` | `provider, started_at DESC` |
| `wx_ingest_runs_geohash_started_at_desc_idx` | `geohash, started_at DESC` |

---

### 10. `wx_provider_health` — 供應商健康度

`wx-provider-health-refresh` 每 5 分鐘彙整 `wx_ingest_runs` 的近 15 分鐘記錄，寫入此表。

```
wx_provider_health
├── provider              TEXT  PK
├── failure_rate_15m      NUMERIC  NULL     ← 0.0–1.0
├── p95_latency_ms        INTEGER  NULL
├── circuit_open_until    TIMESTAMPTZ  NULL ← 熔斷開放截止時間（目前預留）
└── updated_at            TIMESTAMPTZ  DEFAULT now()
```

---

### 11. `wx_region_codes` — 國家/地區代碼映射

將地理座標映射為 `country_code + region_code` 的結構化索引，供 Country/Region API 使用。

```
wx_region_codes
├── id            BIGSERIAL  PK
├── country_code  TEXT  NOT NULL
├── region_code   TEXT  NOT NULL         ← 自動生成，格式：{name}-{geohash4}
├── region_name   TEXT  NOT NULL
├── geohash       TEXT  NOT NULL  (UNIQUE)
├── place_id      TEXT  NULL
├── lat           DOUBLE PRECISION  NOT NULL
├── lon           DOUBLE PRECISION  NOT NULL
├── timezone      TEXT  NOT NULL  DEFAULT 'UTC'
├── admin1        TEXT  NULL
├── admin2        TEXT  NULL
├── admin3        TEXT  NULL
├── admin4        TEXT  NULL
├── locality      TEXT  NULL
├── name          TEXT  NULL
├── created_at    TIMESTAMPTZ  DEFAULT now()
└── updated_at    TIMESTAMPTZ  DEFAULT now()

UNIQUE: (country_code, region_code)
UNIQUE: (geohash)
```

**索引**

| 索引名稱 | 欄位 |
|---|---|
| `wx_region_codes_country_idx` | `country_code` |
| `wx_region_codes_country_admin_idx` | `country_code, admin1, admin2, admin3, admin4, locality` |

**region_code 生成邏輯**

```sql
lower(regexp_replace(
  coalesce(locality, admin4, admin3, admin2, admin1, name, geohash),
  '[^a-zA-Z0-9]+', '-', 'g'
)) || '-' || left(geohash, 4)

-- 範例：
-- locality="Kowloon", geohash="wei3cb" → "kowloon-wei3"
-- admin1="Hong Kong", geohash="wei3" → "hong-kong-wei3"
```

**資料來源優先序**（`wx-sync-region-codes`）

1. `wx_locations` 回填（已知地點）
2. Open-Meteo Reverse Geocoding（熱點補齊）
3. 內建 seed（HK/CN/MO/TW/JP/US 基礎點）

---

### 12. `wx_region_cache` — 地區 API 快取

專門給 Country/Region API 使用的快取，與通用 `wx_cache` 分離。

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

**索引**

| 索引名稱 | 欄位 |
|---|---|
| `wx_region_cache_country_region_idx` | `country_code, region_code, granularity` |
| `wx_region_cache_expires_at_idx` | `expires_at` |

---

### 13. `wx_air_quality_series` — 空氣質素時間序列

```
wx_air_quality_series
├── id                    UUID  PK
├── geohash               CHAR(6)  NOT NULL
├── lat                   DOUBLE PRECISION  NOT NULL
├── lon                   DOUBLE PRECISION  NOT NULL
├── valid_time            TIMESTAMPTZ  NOT NULL
├── pm10                  DOUBLE PRECISION  NULL   (μg/m³)
├── pm2_5                 DOUBLE PRECISION  NULL   (μg/m³)
├── carbon_monoxide       DOUBLE PRECISION  NULL   (μg/m³)
├── nitrogen_dioxide      DOUBLE PRECISION  NULL   (μg/m³)
├── sulphur_dioxide       DOUBLE PRECISION  NULL   (μg/m³)
├── ozone                 DOUBLE PRECISION  NULL   (μg/m³)
├── aerosol_optical_depth DOUBLE PRECISION  NULL
├── dust                  DOUBLE PRECISION  NULL   (μg/m³)
├── uv_index              DOUBLE PRECISION  NULL
├── uv_index_clear_sky    DOUBLE PRECISION  NULL
├── alder_pollen          DOUBLE PRECISION  NULL   (grains/m³)
├── birch_pollen          DOUBLE PRECISION  NULL
├── grass_pollen          DOUBLE PRECISION  NULL
├── mugwort_pollen        DOUBLE PRECISION  NULL
├── olive_pollen          DOUBLE PRECISION  NULL
├── ragweed_pollen        DOUBLE PRECISION  NULL
├── us_aqi                INTEGER  NULL
├── european_aqi          INTEGER  NULL
├── provider              TEXT  NOT NULL  DEFAULT 'open_meteo'
├── fetched_at            TIMESTAMPTZ  NOT NULL
└── created_at            TIMESTAMPTZ  NOT NULL

UNIQUE: (geohash, valid_time, provider)
```

**索引**

| 索引名稱 | 欄位 |
|---|---|
| `wx_air_quality_geohash_valid` | `geohash, valid_time DESC` |
| `wx_air_quality_valid_time` | `valid_time DESC` |

---

### 14. `wx_metar_observations` — METAR 機場觀測

儲存來自 NOAA Aviation Weather Center 的 METAR 實況觀測（35 個全球優先站）。

```
wx_metar_observations
├── id                       UUID  PK
├── station_id               TEXT  NOT NULL        ← ICAO 代碼（如 VHHH）
├── geohash                  CHAR(6)  NULL
├── lat                      DOUBLE PRECISION  NULL
├── lon                      DOUBLE PRECISION  NULL
├── elevation_m              DOUBLE PRECISION  NULL
├── observation_time         TIMESTAMPTZ  NOT NULL
├── temp_c                   DOUBLE PRECISION  NULL
├── dewpoint_c               DOUBLE PRECISION  NULL
├── humidity_pct             DOUBLE PRECISION  NULL
├── wind_dir_deg             INTEGER  NULL
├── wind_speed_ms            DOUBLE PRECISION  NULL
├── wind_gust_ms             DOUBLE PRECISION  NULL
├── visibility_m             DOUBLE PRECISION  NULL
├── pressure_hpa             DOUBLE PRECISION  NULL
├── pressure_sea_level_hpa   DOUBLE PRECISION  NULL
├── cloud_cover_pct          INTEGER  NULL
├── weather_code             TEXT  NULL
├── weather_desc             TEXT  NULL
├── raw_metar                TEXT  NULL             ← 原始 METAR 字串
├── fetched_at               TIMESTAMPTZ  DEFAULT now()
└── created_at               TIMESTAMPTZ  DEFAULT now()

UNIQUE: (station_id, observation_time)
```

**35 個全球優先站（ICAO 代碼）**

> VHHH（香港）、ZGGG（廣州）、RCTP（台北）、RJTT（東京）、RKSI（首爾）、
> WSSS（新加坡）、VTBS（曼谷）、WMKK（吉隆坡）、VVTS（胡志明）、
> EGLL（倫敦）、LFPG（巴黎）、EDDF（法蘭克福）、EHAM（阿姆斯特丹）、
> LEMD（馬德里）、LIRF（羅馬）、LSZH（蘇黎世）、UUEE（莫斯科）、
> OMAA（阿布達比）、OEJN（吉達）、HECA（開羅）、FAOR（約翰尼斯堡）、
> HAAB（亞的斯阿貝巴）、DNMM（拉哥斯）、CYYZ（多倫多）、KJFK（紐約）、
> KLAX（洛杉磯）、KORD（芝加哥）、KIAH（休士頓）、KMIA（邁阿密）、
> KATL（亞特蘭大）、SBGR（聖保羅）、SAEZ（布宜諾斯艾利斯）、
> MROC（聖荷西）、SKCL（卡利）、SPIM（利馬）

**索引**

| 索引名稱 | 欄位 |
|---|---|
| `wx_metar_geohash_time` | `geohash, observation_time DESC` |
| `wx_metar_station_time` | `station_id, observation_time DESC` |
| `wx_metar_obs_time` | `observation_time DESC` |

---

### 15. `wx_marine_series` — 海洋時間序列

```
wx_marine_series
├── id                           UUID  PK
├── geohash                      CHAR(6)  NOT NULL
├── lat                          DOUBLE PRECISION  NOT NULL
├── lon                          DOUBLE PRECISION  NOT NULL
├── valid_time                   TIMESTAMPTZ  NOT NULL
├── wave_height_m                DOUBLE PRECISION  NULL
├── wave_direction_deg           DOUBLE PRECISION  NULL
├── wave_period_s                DOUBLE PRECISION  NULL
├── wind_wave_height_m           DOUBLE PRECISION  NULL
├── wind_wave_direction_deg      DOUBLE PRECISION  NULL
├── wind_wave_period_s           DOUBLE PRECISION  NULL
├── swell_wave_height_m          DOUBLE PRECISION  NULL
├── swell_wave_direction_deg     DOUBLE PRECISION  NULL
├── swell_wave_period_s          DOUBLE PRECISION  NULL
├── sea_surface_temperature_c    DOUBLE PRECISION  NULL
├── ocean_current_velocity_ms    DOUBLE PRECISION  NULL
├── ocean_current_direction_deg  DOUBLE PRECISION  NULL
├── provider                     TEXT  NOT NULL  DEFAULT 'open_meteo_marine'
├── fetched_at                   TIMESTAMPTZ  NOT NULL
└── created_at                   TIMESTAMPTZ  NOT NULL

UNIQUE: (geohash, valid_time, provider)
```

**索引**

| 索引名稱 | 欄位 |
|---|---|
| `wx_marine_geohash_valid` | `geohash, valid_time DESC` |
| `wx_marine_valid_time` | `valid_time DESC` |

---

### 16. `wx_webhook_subscriptions` — Webhook 訂閱

```
wx_webhook_subscriptions
├── id              UUID  PK  DEFAULT gen_random_uuid()
├── owner_key       TEXT  NOT NULL          ← 用戶自訂識別鍵
├── callback_url    TEXT  NOT NULL          ← HTTPS only
├── event_types     TEXT[]  NOT NULL        ← ['alert_new', 'risk_high']
├── lat             DOUBLE PRECISION  NULL  ← 地理過濾中心點
├── lon             DOUBLE PRECISION  NULL
├── radius_km       INTEGER  NOT NULL  DEFAULT 50
├── secret          TEXT  NULL              ← HMAC-SHA256 簽名密鑰
├── active          BOOLEAN  NOT NULL  DEFAULT TRUE
├── created_at      TIMESTAMPTZ  NOT NULL  DEFAULT NOW()
├── updated_at      TIMESTAMPTZ  NOT NULL  DEFAULT NOW()
├── last_fired_at   TIMESTAMPTZ  NULL
├── fire_count      INTEGER  NOT NULL  DEFAULT 0
└── failure_count   INTEGER  NOT NULL  DEFAULT 0  ← 連續失敗 ≥ 10 → 自動停用
```

**索引**

| 索引名稱 | 欄位 |
|---|---|
| `idx_wx_webhook_subs_owner` | `owner_key` |
| `idx_wx_webhook_subs_active` | `active` WHERE active = TRUE（partial） |

---

### 17. `wx_webhook_deliveries` — Webhook 派送記錄

```
wx_webhook_deliveries
├── id               UUID  PK
├── subscription_id  UUID  NOT NULL  FK → wx_webhook_subscriptions(id) ON DELETE CASCADE
├── event_type       TEXT  NOT NULL
├── payload          JSONB  NOT NULL  ← 完整派送 body
├── status_code      INTEGER  NULL    ← HTTP 回應碼
├── success          BOOLEAN  NOT NULL  DEFAULT FALSE
├── attempted_at     TIMESTAMPTZ  NOT NULL  DEFAULT NOW()
└── duration_ms      INTEGER  NULL    ← 派送耗時
```

**索引**

| 索引名稱 | 欄位 |
|---|---|
| `idx_wx_webhook_del_sub` | `subscription_id, attempted_at DESC` |
| `idx_wx_webhook_del_attempted` | `attempted_at DESC` |

---

## RLS 安全策略

所有資料表均啟用 Row Level Security。

### 公開讀取（`anon` + `authenticated`）

| 資料表 | Policy 名稱 | 說明 |
|---|---|---|
| `wx_locations` | `wx_locations_read` | 地點索引公開讀 |
| `wx_cache` | `wx_cache_read` | API 快取公開讀 |
| `wx_hourly_series` | `wx_hourly_series_read` | 小時序列公開讀 |
| `wx_daily_series` | `wx_daily_series_read` | 日序列公開讀 |
| `wx_alerts` | `wx_alerts_read` | 警報公開讀 |
| `wx_risk_snapshots` | `wx_risk_snapshots_read` | 風險快照公開讀 |
| `wx_ingest_runs` | `wx_ingest_runs_read` | 可觀測性公開讀 |
| `wx_provider_health` | `wx_provider_health_read` | 供應商健康公開讀 |
| `wx_hotspots` | `wx_hotspots_read` | 熱點公開讀 |
| `wx_alert_feeds` | `wx_alert_feeds_read` | Feed 配置公開讀 |
| `wx_air_quality_series` | `aq_public_read` | AQ 資料公開讀 |
| `wx_metar_observations` | `metar_public_read` | METAR 公開讀 |
| `wx_marine_series` | `marine_public_read` | 海洋資料公開讀 |

### 受限寫入（`service_role` only）

| 資料表 | Policy 名稱 |
|---|---|
| `wx_air_quality_series` | `aq_service_write` |
| `wx_metar_observations` | `metar_service_write` |
| `wx_marine_series` | `marine_service_write` |
| `wx_webhook_subscriptions` | `service_all_webhook_subs` |
| `wx_webhook_deliveries` | `service_all_webhook_del` |

> 其餘資料表無顯式 write policy，寫入靠 Edge Functions 以 `service_role` 繞過 RLS（`supabase.auth.admin`）。

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
LANGUAGE SQL STABLE AS $$
  SELECT a.id, a.source, a.severity, a.title, a.description, a.starts_at, a.ends_at
  FROM public.wx_alerts a
  WHERE (a.ends_at IS NULL OR a.ends_at > now())
    AND (
      a.area_center IS NULL                       -- 無地理資訊的警報仍包含
      OR ST_DWithin(a.area_center, ST_SetSRID(ST_MakePoint(in_lon, in_lat), 4326)::geography, radius)
      OR ST_DWithin(a.area, ST_SetSRID(ST_MakePoint(in_lon, in_lat), 4326)::geography, radius)
    )
  ORDER BY a.starts_at DESC NULLS LAST
  LIMIT 200;
$$;

GRANT EXECUTE ON FUNCTION wx_alerts_nearby TO anon, authenticated;
```

**呼叫方式（Edge Function 內）**

```typescript
const { data } = await supabase.rpc('wx_alerts_nearby', {
  in_lat: 22.3193,
  in_lon: 114.1694,
  in_radius_m: 50000   // 50 km
});
```

---

## Edge Functions 清單

所有 Function 以 Deno/TypeScript 撰寫，部署在 Supabase Edge Functions（全球分散式）。

### 公開 API Functions

| Function | 認證 | HTTP Methods | 說明 |
|---|---|---|---|
| `wx-api-proxy` | public | GET/POST/DELETE/OPTIONS | CORS 代理 + 白名單路由 |
| `wx-geo-forward` | public | GET | 地名搜尋 |
| `wx-geo-reverse` | public | GET | 座標反查 |
| `wx-forecast-hourly` | public | GET | 小時預報 |
| `wx-forecast-daily` | public | GET | 日級預報 |
| `wx-observed-now` | public | GET | 即時觀測 |
| `wx-alerts` | public | GET | 附近警報 |
| `wx-risk` | public | GET | 風險評估 |
| `wx-environment-timeline` | public | GET | 環境時間軸 |
| `wx-country-today` | public | GET | 國家今日 |
| `wx-region` | public | GET | 單一地區 |
| `wx-region-coverage` | public | GET | 覆蓋健康 |
| `wx-air-quality` | public | GET | 空氣質素 |
| `wx-observed-metar` | public | GET | METAR 查詢 |
| `wx-status` | public | GET | 服務健康 |
| `wx-marine` | public | GET | 海洋預報 |
| `wx-solar` | public | GET | 太陽輻射 |
| `wx-historical` | public | GET | 歷史存檔 |
| `wx-astronomy` | public | GET | 天文曆 |
| `wx-bundle` | public | GET | 聚合請求 |
| `wx-indices` | public | GET | 複合指數 |
| `wx-compare` | public | GET | 多地比較 |
| `wx-anomaly` | public | GET | 異常偵測 |
| `wx-webhook-register` | public | GET/POST/DELETE | Webhook 訂閱管理 |
| `wx-webhook-dispatch` | public | GET | 手動觸發派送 |

### 排程 / 維運 Functions（service_role 呼叫）

| Function | 說明 |
|---|---|
| `wx-refresh-hotspots-hourly` | 熱點 hourly forecast 刷新 |
| `wx-refresh-hotspots-daily` | 熱點 daily forecast 刷新 |
| `wx-observed-refresh-hotspots` | 熱點 observed rolling 刷新 |
| `wx-cleanup-expired-cache` | 清理 wx_cache 過期記錄 |
| `wx-prune-time-series` | 修剪舊時間序列 |
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
| `wx-hotspots-seed-global-cities` | 全球城市種子（一次性） |

---

## 共用模組（_shared）

所有 Edge Functions 共用 `supabase/functions/_shared/wx/` 下的模組：

### `types.ts` — 型別定義

定義 `WxHourlyPoint`、`WxDailyPoint`、`WxProvider` 等核心介面。

```typescript
export type WxProvider = "auto" | "open_meteo" | "weatherapi" | "tomorrow_io" | "openweather";

export interface WxHourlyPoint {
  valid_time: string;
  temp_c: number | null;
  feels_like_c: number | null;
  humidity_pct: number | null;
  // ... 共 15 個氣象欄位
  provider: string;
  fetched_at: string;
  confidence: number | null;
}
```

### `provider_chain.ts` — 供應商鏈

管理多供應商優先序與 fallback 邏輯：

```
defaultProviderPriority(): ["open_meteo", "weatherapi", "tomorrow_io", "openweather"]

fetchForecastWithProvider(provider, lat, lon, hours, days)
  → 依 provider 分派到對應 adapter
  → 讀取 Supabase Secrets 取得 API Key
  → 帶 AbortSignal.timeout(10000) 的 fetch（10s 硬超時）
```

### `storage.ts` — 資料寫入

- `buildCacheKey()` — 生成確定性快取鍵
- `tryReadCache()` — 讀取 `wx_cache`（含新鮮度判斷）
- `writeCache()` — 寫入 `wx_cache`
- `upsertHourlySeries()` — 寫入 `wx_hourly_series`
- `upsertDailySeries()` — 寫入 `wx_daily_series`
- `recordIngestRun()` — 寫入 `wx_ingest_runs`

### `location.ts` — 位置解析

- 座標 → geohash 轉換
- 從 `wx_locations` 查找或建立地點記錄
- 呼叫 Open-Meteo Geocoding 補充地點元資料

### `geohash.ts` — Geohash 工具

純計算模組，座標 ↔ geohash 互轉（精度 6 字元 ≈ 1.2 km × 0.6 km）。

### `validate.ts` — 參數驗證

統一的請求參數驗證工具（lat/lon 範圍、hours/days 範圍等）。

### `supabase.ts` — Supabase Client

建立使用 `service_role` 的 Supabase client（繞過 RLS 進行寫入）。

### `http.ts` — HTTP 工具

統一 CORS headers、JSON 回應建構器、錯誤格式化。

### `providers/` — 供應商 Adapters

| 檔案 | 供應商 | API Key 需求 |
|---|---|---|
| `open_meteo.ts` | Open-Meteo | ❌ 免費，無需 Key |
| `weatherapi.ts` | WeatherAPI.com | ✅ `WEATHER_API_KEY` |
| `tomorrow_io.ts` | Tomorrow.io | ✅ `TOMORROW_IO_API_KEY` |
| `openweather.ts` | OpenWeatherMap | ✅ `OPENWEATHER_API_KEY` |

---

## 外部資料來源與抓取流程

### 來源一：Open-Meteo（主力預報）

**用於**：`wx-forecast-hourly`, `wx-forecast-daily`, `wx-environment-timeline`, `wx-indices`, `wx-compare`, `wx-anomaly`

```
Open-Meteo Forecast API
  URL: https://api.open-meteo.com/v1/forecast
  - 免費、無需 API Key
  - 支援全球座標
  - 回傳欄位：temperature_2m, apparent_temperature, relative_humidity_2m,
              dew_point_2m, pressure_msl, precipitation, precipitation_probability,
              snowfall, cloud_cover, visibility, uv_index,
              wind_speed_10m, wind_direction_10m, wind_gusts_10m

抓取流程：
  1. Edge Function 收到請求（lat, lon, hours, days）
  2. 計算 geohash（精度 6）
  3. 查詢 wx_cache：cache_key = "{geohash}|forecast_hourly|hours={n}|..."
  4. [快取命中且新鮮] → 直接回傳快取
  5. [快取 miss / 過期] → fetch Open-Meteo API（AbortSignal.timeout(10s)）
  6. 轉換欄位名稱（temperature_2m → temp_c、wind_speed_10m → wind_ms 等）
  7. 並行寫入：
     a. wx_cache（TTL: 30 分鐘）
     b. wx_hourly_series（upsert by geohash, valid_time, kind, provider）
     c. wx_daily_series（upsert by geohash, date, provider）
  8. 回傳 JSON 回應

Open-Meteo Archive API（歷史 / Anomaly）
  URL: https://archive-api.open-meteo.com/v1/archive
  - 歷史資料 1940 至今
  - 用於 wx-historical、wx-anomaly（7 個採樣年份 × ±7天窗口）
  - cache-control: public, max-age=3600
```

### 來源二：Open-Meteo Air Quality API

**用於**：`wx-air-quality`, `wx-refresh-airquality-hotspots`

```
Open-Meteo Air Quality API
  URL: https://air-quality-api.open-meteo.com/v1/air-quality
  - 免費
  - 回傳：pm10, pm2_5, CO, NO2, SO2, O3, aerosol_optical_depth, dust,
          uv_index, 花粉類（6種）, us_aqi, european_aqi

抓取流程（熱點排程）：
  1. pg_cron 每 3 小時觸發 wx-refresh-airquality-hotspots（POST）
  2. 讀取 wx_hotspots 全部熱點
  3. 並行 fetch Air Quality API（每個熱點）
  4. upsert wx_air_quality_series（UNIQUE: geohash, valid_time, provider）
  5. recordIngestRun 寫入 wx_ingest_runs

即時查詢（GET /wx-air-quality）：
  1. 用戶請求 lat/lon
  2. 先查 wx_air_quality_series（是否有最近 2 小時資料）
  3. [有] → 直接回傳 DB 資料
  4. [無] → live fetch Air Quality API → 寫 DB → 回傳
```

### 來源三：Open-Meteo Marine API

**用於**：`wx-marine`, `wx-refresh-marine-hotspots`

```
Open-Meteo Marine API
  URL: https://marine-api.open-meteo.com/v1/marine
  - 免費
  - 僅覆蓋沿海/離島座標（陸地回 400）
  - 回傳：波高、波向、波週期、湧浪、海溫、洋流速度/方向

抓取流程（熱點排程）：
  1. pg_cron 每 6 小時觸發 wx-refresh-marine-hotspots
  2. 讀取 wx_hotspots
  3. 對每個熱點嘗試 fetch Marine API
  4. 若 HTTP 400（陸地）→ skip，不記錯誤
  5. 成功 → upsert wx_marine_series
```

### 來源四：Open-Meteo Solar API

**用於**：`wx-solar`（pure live fetch，無本地快取）

```
Open-Meteo Solar Radiation API
  URL: https://api.open-meteo.com/v1/forecast（solar 欄位）
  - 回傳：shortwave_radiation, direct_radiation, diffuse_radiation,
          direct_normal_irradiance, global_tilted_irradiance, terrestrial_radiation
  - 支援 tilt / azimuth 面板參數
  - cache-control: public, max-age=3600
```

### 來源五：Open-Meteo Geocoding / Reverse

**用於**：`wx-geo-forward`, `wx-geo-reverse`, `wx-sync-region-codes`

```
Open-Meteo Geocoding API
  URL: https://geocoding-api.open-meteo.com/v1/search
  - 回傳：place_id, name, lat, lon, timezone, country_code, admin1-4, locality, population

Nominatim OSM Reverse Geocoding（Reverse）
  URL: https://nominatim.openstreetmap.org/reverse
  - 免費，但有速率限制（1 req/s）
  - wx-sync-region-codes 以 concurrency=8 控制並行

流程（geo-reverse）：
  1. 用戶請求 lat/lon
  2. fetch Nominatim reverse（10s timeout）
  3. 解析 address 欄位 → admin1/admin2/locality 等
  4. upsert wx_locations
  5. 回傳地點資訊
```

### 來源六：NOAA Aviation Weather Center（METAR）

**用於**：`wx-observed-metar`（GET + POST）

```
NOAA Aviation Weather Center METAR API
  URL: https://aviationweather.gov/api/data/metar
  Params: ids={ICAO1,ICAO2,...}&format=json&hours=3

抓取流程（排程 POST）：
  1. pg_cron 每 30 分鐘（15:00, 45:00）觸發
  2. 批次呼叫 NOAA API，傳入 35 個 ICAO 代碼
  3. 解析 JSON → 轉換欄位（wind_speed_kt→m/s, altim_in_hg→hPa 等）
  4. upsert wx_metar_observations（UNIQUE: station_id, observation_time）

即時查詢（GET）：
  1. 用戶請求（可選 lat/lon/radius_km）
  2. 查詢 wx_metar_observations 最近 3 小時記錄
  3. 若有 lat/lon 過濾 → haversine 距離篩選
  4. 回傳結果（不觸發即時 fetch）
```

### 來源七：官方警報系統（HKO / SMG / NWS / CAP）

```
香港天文台（HKO）
  URL: https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=warnsumsml
  - JSON 格式
  - 每 5 分鐘 ingest
  - bbox：[113.8, 22.1, 114.5, 22.6]（香港邊界）

澳門氣象局（SMG）
  URL: https://www.smg.gov.mo/zh/subpage/351/page/351
  - HTML 頁面解析（DOM 元素）
  - 每 10 分鐘 ingest
  - 僅在偵測到有效訊號時插入（無訊號不寫 DB）
  - bbox：[113.5, 22.1, 113.6, 22.2]（澳門邊界）

美國 NWS GeoJSON（via wx-alerts-ingest-nws）
  URL: https://api.weather.gov/alerts/active?status=actual&message_type=alert
  - GeoJSON FeatureCollection 格式
  - 包含 polygon 幾何，直接存入 PostGIS area 欄位
  - 每 10 分鐘 ingest
  - upsert by (source='NWS', ext_id=alert.id)

CAP/Atom Feeds（via wx-alerts-ingest-cap）
  來源：wx_alert_feeds 表中 is_enabled=true 的 feed
  - XML/Atom 格式解析
  - 提取 polygon/circle → bbox + area_center
  - 每 10 分鐘 ingest

警報 ingest 通用流程：
  1. pg_cron 觸發 → POST Edge Function
  2. fetch 外部 API（10s timeout）
  3. 解析 payload → 提取地理資訊（polygon / bbox / circle）
  4. upsert wx_alerts（by source + ext_id 去重）
  5. 警報查詢：呼叫 wx_alerts_nearby RPC（PostGIS ST_DWithin）
```

### 來源八：WeatherAPI / Tomorrow.io / OpenWeatherMap（備援）

```
備援供應商觸發條件：
  1. provider=auto（預設）時，Open-Meteo 失敗（10s timeout / HTTP 5xx）
  2. provider 參數明確指定
  3. （預留）wx_provider_health 顯示 Open-Meteo failure_rate_15m > 0.5

供應商優先序：
  open_meteo → weatherapi → tomorrow_io → openweather

各供應商 API Key 從 Supabase Secrets 讀取：
  - WEATHER_API_KEY        ← WeatherAPI.com
  - TOMORROW_IO_API_KEY    ← Tomorrow.io
  - OPENWEATHER_API_KEY    ← OpenWeatherMap

所有供應商 fetch 均帶 AbortSignal.timeout(10000)（10s 硬超時）
```

---

## 供應商鏈與備援機制

### 正常流程

```
用戶請求 GET /wx-forecast-hourly?lat=22.3&lon=114.2&provider=auto
    │
    ▼
[1] 計算 geohash = "wei3cb"
    │
    ▼
[2] 查詢 wx_cache（cache_key = "wei3cb|forecast_hourly|hours=72|provider=auto"）
    │
    ├── [命中 & 新鮮] ──────────────────────────────────→ 回傳快取（~5ms）
    │
    └── [未命中 / 過期]
            │
            ▼
[3] 嘗試 Open-Meteo（主力，無 Key）
            │
            ├── [成功] → 寫 wx_cache + wx_hourly_series → 回傳（~400ms）
            │
            └── [失敗（timeout / 5xx）]
                    │
                    ▼
[4] 嘗試 WeatherAPI（備援 1，需 Key）
                    │
                    ├── [成功] → 寫快取 → 回傳
                    │
                    └── [失敗]
                            │
                            ▼
[5] 嘗試 Tomorrow.io → OpenWeatherMap（備援 2, 3）
```

### 熔斷器（預留機制）

`wx_provider_health.circuit_open_until` 欄位已預留，目前未啟用自動熔斷。
`wx-provider-health-refresh` 每 5 分鐘計算 15 分鐘窗口內的失敗率和 P95 延遲，
可在應用層讀取 `GET /wx-status` 取得供應商健康度。

---

## pg_cron 排程全覽

17 個排程任務，全部透過 `pg_net.http_post()` 呼叫 Edge Functions：

| 排程名稱 | Cron 表達式 | 觸發函式 | 說明 |
|---|---|---|---|
| `novaweather_refresh_hotspots_hourly` | `*/30 * * * *` | wx-refresh-hotspots-hourly | 熱點 hourly 預取（每 30 分鐘） |
| `novaweather_refresh_hotspots_daily` | `0 */6 * * *` | wx-refresh-hotspots-daily | 熱點 daily 預取（每 6 小時） |
| `novaweather_observed_refresh_hotspots` | `*/15 * * * *` | wx-observed-refresh-hotspots | 熱點 observed 更新（每 15 分鐘） |
| `novaweather_alerts_ingest_cap` | `*/10 * * * *` | wx-alerts-ingest-cap | CAP Atom feeds（每 10 分鐘） |
| `novaweather_alerts_ingest_hko` | `*/5 * * * *` | wx-alerts-ingest-hko | 香港天文台警報（每 5 分鐘） |
| `novaweather_alerts_ingest_smg` | `*/10 * * * *` | wx-alerts-ingest-smg | 澳門氣象訊號（每 10 分鐘） |
| `novaweather_alerts_ingest_nws` | `*/10 * * * *` | wx-alerts-ingest-nws | NWS GeoJSON 警報（每 10 分鐘） |
| `novaweather_provider_health_refresh` | `*/5 * * * *` | wx-provider-health-refresh | 供應商健康度（每 5 分鐘） |
| `novaweather_cleanup_expired_cache` | `17 * * * *` | wx-cleanup-expired-cache | 清理過期快取（每小時 :17） |
| `novaweather_prune_time_series` | `41 2 * * *` | wx-prune-time-series | 修剪舊時間序列（每天 02:41） |
| `novaweather_alerts_prune` | `53 2 * * *` | wx-alerts-prune | 清理過期警報（每天 02:53） |
| `novaweather_refresh_airquality_hotspots` | `5 */3 * * *` | wx-refresh-airquality-hotspots | AQ 熱點更新（每 3 小時 :05） |
| `novaweather_observed_metar` | `15,45 * * * *` | wx-observed-metar (POST) | METAR 刷新（每 30 分鐘，錯開） |
| `novaweather_refresh_marine_hotspots` | `35 */6 * * *` | wx-refresh-marine-hotspots | 海洋熱點更新（每 6 小時 :35） |
| `novaweather_sync_region_codes` | `*/30 * * * *` | wx-sync-region-codes | Region code 同步（每 30 分鐘） |
| `novaweather_webhook_dispatch` | `*/5 * * * *` | wx-webhook-dispatch | Webhook 事件派送（每 5 分鐘） |
| `novaweather_prune_webhook_deliveries` | `15 3 * * *` | _(純 SQL)_ | 清理 7 天前 delivery 記錄（每天 03:15） |

> `novaweather_prune_webhook_deliveries` 直接執行 `DELETE FROM wx_webhook_deliveries WHERE attempted_at < NOW() - INTERVAL '7 days'`，不經 Edge Function。

---

## 快取策略

| 資料類型 | TTL | 快取表 | 說明 |
|---|---|---|---|
| 預報資料（hourly/daily） | 30 分鐘 | `wx_cache` | 一般預報快取 |
| 觀測資料（observed） | 15 分鐘 | `wx_cache` | 資料更新較快 |
| 警報資料 | 5 分鐘 | `wx_cache` | 警報需快速更新 |
| 地區資料（region/country） | 30 分鐘 | `wx_region_cache` | 批量地區快取 |
| 歷史資料（historical） | 1 小時 | HTTP `cache-control` | 歷史不變，可用 CDN |
| 異常偵測（anomaly） | 1 小時 | HTTP `cache-control` | 歷史常態不變 |
| 複合指數（indices） | 15 分鐘 | HTTP `cache-control` | 指數計算快取 |
| 多地比較（compare） | 10 分鐘 | HTTP `cache-control` | 並行資料快取 |

---

## Secrets 管理

所有 API Key 和敏感資訊存放於 **Supabase Secrets / Vault**，在 Edge Function 中透過 `Deno.env.get()` 讀取：

| Secret 名稱 | 用途 |
|---|---|
| `WEATHER_API_KEY` | WeatherAPI.com 備援供應商 |
| `TOMORROW_IO_API_KEY` | Tomorrow.io 備援供應商 |
| `OPENWEATHER_API_KEY` | OpenWeatherMap 備援供應商 |
| `SUPABASE_SERVICE_ROLE_KEY` | 由 Supabase 平台自動注入，Edge Function 寫入 DB 用 |
| `SUPABASE_URL` | 由 Supabase 平台自動注入 |

> **禁止**在程式碼、前端、公開文件中硬編碼任何 API Key。

---

## 資料流程圖

### 用戶即時請求流程

```
用戶 / 前端
    │ GET /wx-forecast-hourly?lat=22.3&lon=114.2
    ▼
wx-api-proxy
    │ 白名單驗證 → 轉發
    ▼
wx-forecast-hourly
    ├── [1] 解析 lat/lon → geohash
    ├── [2] 查 wx_cache ──→ [命中] → 回傳 JSON ✓
    │                └── [miss]
    ├── [3] fetchForecastWithProvider(open_meteo, ...)
    │         └── fetch https://api.open-meteo.com/v1/forecast
    │               （AbortSignal.timeout 10s）
    ├── [4] 轉換欄位格式
    ├── [5] 並行寫入：
    │         ├── wx_cache（TTL 30min）
    │         └── wx_hourly_series（upsert）
    └── [6] 回傳 JSON ✓
```

### pg_cron 熱點預取流程

```
pg_cron（每 30 分鐘）
    │ SELECT net.http_post('wx-refresh-hotspots-hourly')
    ▼
wx-refresh-hotspots-hourly
    ├── [1] SELECT geohash, lat, lon FROM wx_hotspots ORDER BY priority DESC
    ├── [2] 對每個熱點（並行）：
    │         ├── fetchForecastWithProvider(open_meteo, lat, lon, 72h, 14d)
    │         ├── upsert wx_hourly_series
    │         ├── upsert wx_daily_series
    │         └── recordIngestRun(provider, geohash, status, latency_ms)
    └── [3] UPDATE wx_hotspots SET last_refresh_hourly_at = now()
```

### 警報 ingest 流程（以 NWS 為例）

```
pg_cron（每 10 分鐘）
    │ SELECT net.http_post('wx-alerts-ingest-nws')
    ▼
wx-alerts-ingest-nws
    ├── [1] fetch https://api.weather.gov/alerts/active?status=actual
    │         （GeoJSON FeatureCollection）
    ├── [2] 解析每個 Feature：
    │         ├── properties.id → ext_id
    │         ├── geometry.coordinates → PostGIS polygon → area
    │         ├── centroid 計算 → area_center
    │         └── properties.* → severity, headline, effective, expires
    ├── [3] UPSERT wx_alerts
    │         ON CONFLICT (source, ext_id) DO UPDATE
    └── [4] 回傳 ingest 統計
```

### Webhook 派送流程

```
pg_cron（每 5 分鐘）
    │ SELECT net.http_post('wx-webhook-dispatch')
    ▼
wx-webhook-dispatch
    ├── [1] 計算 since = now() - 6 minutes
    ├── [2] SELECT * FROM wx_webhook_subscriptions WHERE active = TRUE
    ├── [3] SELECT * FROM wx_alerts WHERE created_at > since（新警報）
    ├── [4] 對每個訂閱（Promise.allSettled 並行）：
    │         ├── haversine 地理過濾（訂閱有 lat/lon 時）
    │         ├── 事件類型過濾（event_types 交集）
    │         ├── [有匹配事件] 建構 payload
    │         ├── [有 secret] HMAC-SHA256 簽名 → X-WxHook-Signature header
    │         ├── POST callback_url（AbortSignal.timeout 8s）
    │         ├── INSERT wx_webhook_deliveries（記錄結果）
    │         ├── UPDATE fire_count / failure_count
    │         └── [failure_count ≥ 10] SET active = FALSE（自動停用）
    └── [5] 回傳派送統計
```

### Region Code 同步流程

```
pg_cron（每 30 分鐘）
    │
    ▼
wx-sync-region-codes
    ├── [1] 從 wx_locations 回填（已知地點 → upsert wx_region_codes）
    ├── [2] 從 wx_hotspots 補齊：
    │         ├── 查找尚未在 wx_region_codes 的熱點 geohash
    │         ├── 批次呼叫 Nominatim reverse（concurrency=8）
    │         └── upsert wx_region_codes
    ├── [3] 寫入內建 seed（HK/CN/MO/TW/JP/US）
    └── [4] 回傳統計
```

---

## Migration 歷史

| 版本 | Migration 檔案 | 內容 |
|---|---|---|
| v0.2.5 | `20260430150000_init_wx_schema.sql` | 基礎 Schema（wx_locations, wx_cache, wx_hourly_series, wx_daily_series, wx_alerts, wx_risk_snapshots, wx_ingest_runs, wx_provider_health） |
| v0.2.5 | `20260430151000_init_wx_rls.sql` | RLS 安全策略 |
| v0.2.5 | `20260430152000_add_wx_hotspots.sql` | wx_hotspots 熱點表 |
| v0.3.x | `20260501021000_wx_locations_place_id.sql` | wx_locations 加 place_id 欄位 |
| v0.5.0 | `20260501022000_wx_alerts_nearby_bbox_rpc.sql` | wx_alerts_nearby RPC |
| v0.5.0 | `20260501022500_wx_locations_admin34.sql` | wx_locations 加 admin3/4/locality |
| v0.5.0 | `20260501023000_wx_cloud_sync_and_cron.sql` | PostGIS 擴充、wx_alerts 地理欄位、wx_alert_feeds、10 個 cron jobs |
| v0.5.0 | `20260501024000_secure_wx_alerts_nearby_search_path.sql` | RPC search_path 安全修正 |
| v0.4.x | `20260501050000_add_region_mapping_and_cache.sql` | wx_region_codes + wx_region_cache + 初始 seed |
| v0.4.x | `20260501052000_schedule_region_code_sync.sql` | novaweather_sync_region_codes cron |
| v0.5.0 | `20260502000000_add_air_quality_metar_nws.sql` | wx_air_quality_series + wx_metar_observations + NWS feed + 3 cron jobs |
| v0.6.0 | `20260502010000_add_marine_series.sql` | wx_marine_series + marine cron |
| v0.9.0 | `20260503010000_add_webhook_subscriptions.sql` | wx_webhook_subscriptions + wx_webhook_deliveries + 2 cron jobs |
