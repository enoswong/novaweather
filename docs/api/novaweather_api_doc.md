# NovaWeather API 文件 v1.0.0

## 版本狀態
✅ 已完成 | ▢ 進行中 | ✖️ 已移除

- [✅] NovaWeather API DOC [進度 100%] (v0.2.5)
- [✅] Environment Timeline API [進度 100%] (v0.3.0)
- [✅] Country/Region + Region Sync API [進度 100%] (v0.4.1)
- [✅] Region Coverage Health API [進度 100%] (v0.4.2)
- [✅] Geo-Reverse 修正（Nominatim OSM）+ SMG 警報地理 + CAP bbox [進度 100%] (v0.5.0)
- [✅] Air Quality API + METAR 觀測 + NWS GeoJSON 警報 [進度 100%] (v0.5.0)
- [✅] Marine API + Solar API + Historical Archive API + Astronomy API [進度 100%] (v0.6.0)
- [✅] Bundle API（單請求並行多資料集）+ 供應商 10s 超時修正 [進度 100%] (v0.7.0)
- [✅] 複合指數 API + 多地比較 API + 氣候異常偵測 API [進度 100%] (v0.8.0)
- [✅] Webhook 推送 API（訂閱警報/風險事件，HMAC 簽名，每 5 分鐘派送）[進度 100%] (v0.9.0)
- [✅] API 實測頁全面更新（35 端點、9 群組、lat/lon + 專用欄位）[進度 100%] (v0.9.0)
- [✅] **v0.9.1**：UTC 時區標準化（Open-Meteo timezone=UTC）+ wx-status 系統健康 API + 呼叫慣例文件修正
- [✅] **v1.0.0**：Multi-Provider 地理路由（Met Norway EU / Pirate Weather 北美）+ 快取鍵正規化 + Webhook 異步解耦（fanout + worker）+ DB 月分區 + Nowcasting minutely_15 + 預報函式非致命 DB 寫入

---

## 概述

NovaWeather 對外只提供一組穩定的 `/wx/*` HTTP API，用於：

- **全球天氣預報**（hourly / daily）
- **近似即時觀測**（observed now + 熱點 observed rolling）
- **官方警報**（CAP/Atom feeds + 港澳官方來源 + 美國 NWS），並支援 **座標 + 半徑** 查詢
- **風險 / 環境變化**（以預報 + 附近官方警報計算 risk level + reasons）
- **專項資料**（空氣質素、海洋、太陽輻射、歷史存檔、天文曆、METAR 觀測）
- **分析功能**（複合指數、多地比較、氣候異常偵測、聚合 Bundle）
- **Webhook 推送**（訂閱警報/風險事件，自動派送）
- **後端維運 API**（熱點預取、清 cache、修剪時間序列、供應商健康度、alerts 清理）

**設計原則：**
- **SI 單位**：所有數值以 SI/通用單位回傳（溫度 °C、風 m/s、雨量 mm、壓力 hPa）。
- **缺值策略**：供應商缺少的欄位回 `null`（不改結構、不改欄位名）。
- **可追溯性**：回應 meta 會包含 `provider` 與 `fetched_at`。

---

## Base URL

```
https://<project-ref>.supabase.co/functions/v1
```

> 範例中以 `$BASE` 代替完整 Base URL。

### 呼叫慣例

文件中的端點以邏輯名稱標示（例如 `GET /wx-geo-forward`），對應 Supabase Edge Function 名稱。**實際調用有兩種方式**：

| 方式 | 格式 | 適用場景 |
|---|---|---|
| **直接呼叫** | `GET $BASE/<function-name>?params` | 後端 / Server-to-Server |
| **CORS Proxy** | `GET $BASE/wx-api-proxy?fn=<function-name>&params` | 前端跨域（無 CORS 問題） |

```bash
# 直接呼叫（後端）
curl "$BASE/wx-geo-forward?q=Tokyo"

# CORS Proxy（前端）
curl "$BASE/wx-api-proxy?fn=wx-geo-forward&q=Tokyo"
```

> 早期文件混用了 `/wx/geo/forward`（REST 風格路徑）與 `wx-geo-forward`（Function 名稱）。**v0.9.1 起統一使用 Function 名稱格式。**

---

## 認證與安全

### 公開讀取（GET）

目前 `/wx/*` 的 GET API 設計成可公開讀取（仍建議在產品層加上 rate limit / WAF）。

```bash
# 公開 GET — 不需要 Authorization header
curl "$BASE/wx-forecast-hourly?lat=22.3193&lon=114.1694"
```

### 受控寫入（POST / 排程任務）

所有會寫入資料庫、清理資料、或 ingest 的 POST functions **只能在安全環境**（例如 pg_cron Scheduler）呼叫：

```bash
curl -X POST "$BASE/wx-refresh-hotspots-hourly" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"
```

> **禁止**在前端 / 客戶端使用 `service_role`。詳見 `docs/security.md`。

---

## 通用 Query 參數

| 參數 | 說明 | 預設 |
|---|---|---|
| `lat` | 緯度（-90 ~ 90） | — |
| `lon` | 經度（-180 ~ 180） | — |
| `place_id` | 精準位置識別（由 `wx-geo-forward` 取得） | — |
| `provider` | `auto \| open_meteo \| met_norway \| pirate_weather \| weatherapi \| tomorrow_io \| openweather` | `auto` |
| `allow_live_fetch` | `true \| false`；false 時僅回傳 cron 已寫入的快取資料 | `true` |

`lat/lon` 與 `place_id` 二擇一（forecast / observed / alerts / risk 類端點）。

---

## 通用回應 meta

多數 GET 端點回應包含：

```json
{
  "fetched_at": "2026-05-03T08:00:00.000Z",
  "timezone": "Asia/Hong_Kong",
  "lat": 22.3193,
  "lon": 114.1694,
  "geohash": "wei3",
  "place_id": 1819729,
  "country_code": "HK",
  "admin1": "Hong Kong",
  "locality": "Kowloon",
  "name": "Hong Kong",
  "provider": "open_meteo"
}
```

---

## 錯誤格式（統一）

```json
{ "error": "Bad Request", "detail": "lat is required" }
```

HTTP 狀態碼：`400` 參數錯誤 / `404` 資源不存在 / `500` 伺服器錯誤 / `503` 上游超時。

---

## API 1：Geo — 地名 / 座標轉換

### `GET /wx/geo/forward` — 地名搜尋

把地名查詢成候選位置清單（Open-Meteo Geocoding），回傳 `place_id` 供後續查詢使用。

**Query 參數**

| 參數 | 必填 | 說明 |
|---|---|---|
| `q` | ✅ | 地名，支援路徑輸入 `廣東省/深圳/寶安區` |
| `country_code` | — | ISO-3166-1 alpha-2，例如 `HK` |
| `language` | — | 回傳語言，例如 `zh` |
| `limit` | — | 1–50，預設 10 |

**範例**

```bash
curl "$BASE/wx-geo-forward?q=Hong+Kong&country_code=HK&limit=3"
```

**預期回應 200**

```json
{
  "meta": {
    "q": "Hong Kong",
    "name_query": "Hong Kong",
    "path_hints": [],
    "limit": 3,
    "language": null,
    "country_code": "HK",
    "upstream_latency_ms": 143
  },
  "places": [
    {
      "place_id": 1819729,
      "name": "Hong Kong",
      "lat": 22.3193,
      "lon": 114.1694,
      "geohash": "wei3",
      "timezone": "Asia/Hong_Kong",
      "country_code": "HK",
      "admin1": "Hong Kong",
      "admin2": null,
      "admin3": null,
      "admin4": null,
      "locality": null,
      "feature_code": "PPLC",
      "population": 7491609
    },
    {
      "place_id": 1819356,
      "name": "Kowloon",
      "lat": 22.3167,
      "lon": 114.1833,
      "geohash": "wei3",
      "timezone": "Asia/Hong_Kong",
      "country_code": "HK",
      "admin1": "Hong Kong",
      "admin2": null,
      "admin3": null,
      "admin4": null,
      "locality": "Kowloon",
      "feature_code": "PPL",
      "population": 2108419
    }
  ]
}
```

---

### `GET /wx/geo/reverse` — 座標反查

把座標反查成最近的行政區資訊（Nominatim OSM）。

**Query 參數**

| 參數 | 必填 | 說明 |
|---|---|---|
| `lat` | ✅ | 緯度 |
| `lon` | ✅ | 經度 |
| `language` | — | 回傳語言 |

**範例**

```bash
curl "$BASE/wx-geo-reverse?lat=22.3193&lon=114.1694"
```

**預期回應 200**

```json
{
  "meta": {
    "lat": 22.3193,
    "lon": 114.1694,
    "language": null,
    "upstream_latency_ms": 218
  },
  "place": {
    "place_id": 1819729,
    "name": "Hong Kong",
    "lat": 22.3193,
    "lon": 114.1694,
    "geohash": "wei3",
    "timezone": "Asia/Hong_Kong",
    "country_code": "HK",
    "admin1": "Hong Kong",
    "admin2": null,
    "admin3": null,
    "admin4": null,
    "locality": null,
    "feature_code": "PPLC"
  }
}
```

---

## API 2：Forecast — 預報

> **v1.0.0 可靠性**：預報函式採「非致命 DB 寫入」設計——即使時間序列入庫、快取寫入或 ingest_run 記錄失敗，API 仍會正常回傳天氣資料（錯誤僅記錄至日誌）。

### `GET /wx/forecast/hourly` — 逐小時預報

取得未來最多 168 小時（7 天）的小時級預報。

**Query 參數**

| 參數 | 必填 | 說明 | 預設 |
|---|---|---|---|
| `lat` / `lon` | ✅（與 place_id 二擇一） | 座標 | — |
| `place_id` | ✅（與 lat/lon 二擇一） | 位置 ID | — |
| `hours` | — | 1–168 | 72 |
| `provider` | — | `auto \| open_meteo \| met_norway \| pirate_weather \| weatherapi \| tomorrow_io \| openweather` | `auto` |

> **`provider=auto` 地理路由（v1.0.0）**：EU 43 個國家優先使用 `met_norway`（ECMWF 模型）；美國/加拿大（且設有 `PIRATE_WEATHER_API_KEY`）優先使用 `pirate_weather`（Dark Sky 算法）；其餘地區使用 `open_meteo` → `weatherapi` → `tomorrow_io` 順序備援。

**範例**

```bash
curl "$BASE/wx-forecast-hourly?lat=22.3193&lon=114.1694&hours=24"
```

**預期回應 200**

```json
{
  "meta": {
    "provider": "open_meteo",
    "fetched_at": "2026-05-03T08:00:00.000Z",
    "timezone": "Asia/Hong_Kong",
    "lat": 22.3193,
    "lon": 114.1694,
    "geohash": "wei3",
    "hours": 24
  },
  "hourly": [
    {
      "valid_time": "2026-05-03T08:00:00Z",
      "temp_c": 27.4,
      "apparent_temp_c": 30.1,
      "dewpoint_c": 23.5,
      "humidity_pct": 80,
      "precip_mm": 0.0,
      "precip_prob": 5,
      "snow_depth_m": null,
      "wind_speed_ms": 4.2,
      "wind_dir_deg": 135,
      "wind_gust_ms": 7.8,
      "cloud_pct": 45,
      "visibility_m": 16000,
      "pressure_hpa": 1009.2,
      "uv_index": 6.3,
      "weather_code": 2
    },
    {
      "valid_time": "2026-05-03T09:00:00Z",
      "temp_c": 28.1,
      "apparent_temp_c": 31.4,
      "dewpoint_c": 23.8,
      "humidity_pct": 78,
      "precip_mm": 0.0,
      "precip_prob": 8,
      "snow_depth_m": null,
      "wind_speed_ms": 4.8,
      "wind_dir_deg": 140,
      "wind_gust_ms": 8.5,
      "cloud_pct": 55,
      "visibility_m": 15000,
      "pressure_hpa": 1009.0,
      "uv_index": 7.1,
      "weather_code": 2
    }
    // ... 最多 hours 筆
  ]
}
```

**weather_code 對照（WMO）**
| 代碼 | 說明 |
|---|---|
| 0 | 晴空 |
| 1-3 | 晴到陰 |
| 45,48 | 霧 |
| 51-67 | 毛毛雨/雨 |
| 71-77 | 雪 |
| 80-82 | 陣雨 |
| 85,86 | 陣雪 |
| 95 | 雷暴 |
| 96,99 | 強雷暴 |

---

### `GET /wx-forecast-daily` — 逐日預報

取得未來最多 16 天的日級預報。

> **時區說明**：回應中 `daily[].date` 為 **UTC 日期**（`YYYY-MM-DD`），以 UTC 午夜為日界線。`meta.timezone` 代表地點所屬時區，僅作參考用——客戶端如需顯示「本地今日」需自行換算。

**Query 參數**

| 參數 | 必填 | 說明 | 預設 |
|---|---|---|---|
| `lat` / `lon` | ✅ | 座標 | — |
| `place_id` | ✅ | 位置 ID | — |
| `days` | — | 1–16 | 14 |
| `provider` | — | `auto \| open_meteo \| met_norway \| pirate_weather \| weatherapi \| tomorrow_io \| openweather` | `auto` |

**範例**

```bash
curl "$BASE/wx-forecast-daily?lat=22.3193&lon=114.1694&days=7"
```

**預期回應 200**

```json
{
  "meta": {
    "provider": "open_meteo",
    "fetched_at": "2026-05-03T08:00:00.000Z",
    "timezone": "Asia/Hong_Kong",
    "lat": 22.3193,
    "lon": 114.1694,
    "geohash": "wei3",
    "days": 7
  },
  "daily": [
    {
      "date": "2026-05-03",
      "temp_min_c": 23.8,
      "temp_max_c": 29.5,
      "apparent_temp_min_c": 25.0,
      "apparent_temp_max_c": 33.2,
      "precip_sum_mm": 1.2,
      "precip_prob_max": 30,
      "wind_max_ms": 9.3,
      "wind_dir_dominant_deg": 138,
      "uv_index_max": 8.5,
      "sunrise_utc": "21:53",
      "sunset_utc": "11:02",
      "weather_code": 61
    },
    {
      "date": "2026-05-04",
      "temp_min_c": 24.1,
      "temp_max_c": 30.2,
      "apparent_temp_min_c": 25.8,
      "apparent_temp_max_c": 34.1,
      "precip_sum_mm": 0.0,
      "precip_prob_max": 10,
      "wind_max_ms": 7.1,
      "wind_dir_dominant_deg": 145,
      "uv_index_max": 9.2,
      "sunrise_utc": "21:52",
      "sunset_utc": "11:03",
      "weather_code": 2
    }
    // ... 最多 days 筆
  ]
}
```

---

## API 3：Observed — 近即時觀測

### `GET /wx/observed/now` — 即時觀測

取得近似即時觀測值（以資料庫內最新觀測 / 最近序列近似 current）。

**Query 參數**

| 參數 | 必填 | 說明 |
|---|---|---|
| `lat` / `lon` | ✅ | 座標 |
| `place_id` | ✅ | 位置 ID |

**範例**

```bash
curl "$BASE/wx-observed-now?lat=22.3193&lon=114.1694"
```

**預期回應 200**

```json
{
  "meta": {
    "fetched_at": "2026-05-03T08:00:00.000Z",
    "timezone": "Asia/Hong_Kong",
    "lat": 22.3193,
    "lon": 114.1694,
    "geohash": "wei3"
  },
  "observed": {
    "valid_time": "2026-05-03T07:45:00Z",
    "temp_c": 27.2,
    "apparent_temp_c": 29.8,
    "dewpoint_c": 23.2,
    "humidity_pct": 79,
    "precip_mm": 0.0,
    "wind_speed_ms": 4.1,
    "wind_dir_deg": 130,
    "wind_gust_ms": 7.2,
    "cloud_pct": 40,
    "visibility_m": 16000,
    "pressure_hpa": 1009.5,
    "uv_index": 5.8,
    "weather_code": 2
  }
}
```

> `observed` 若無資料則為 `null`。

---

## API 4：Alerts — 官方警報

### `GET /wx/alerts` — 座標附近警報

取得座標附近的「仍在有效期」官方警報（CAP/Atom + HKO + SMG + NWS GeoJSON）。

**Query 參數**

| 參數 | 必填 | 說明 | 預設 |
|---|---|---|---|
| `lat` / `lon` | ✅ | 座標 | — |
| `place_id` | ✅ | 位置 ID | — |
| `radius_km` | — | 1–300 | 50 |

**範例**

```bash
curl "$BASE/wx-alerts?lat=22.3193&lon=114.1694&radius_km=100"
```

**預期回應 200（有警報）**

```json
{
  "meta": {
    "fetched_at": "2026-05-03T08:00:00.000Z",
    "lat": 22.3193,
    "lon": 114.1694,
    "radius_km": 100
  },
  "alerts": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "source": "HKO",
      "event_type": "TYPHOON_SIGNAL",
      "severity": "Severe",
      "urgency": "Immediate",
      "headline": "Typhoon Signal No. 3 is in force",
      "description": "The No. 3 Strong Wind Signal is now in force...",
      "effective": "2026-05-03T06:00:00Z",
      "expires": "2026-05-03T14:00:00Z",
      "area": "Hong Kong",
      "bbox": [113.8, 22.1, 114.4, 22.6],
      "centroid_lat": 22.35,
      "centroid_lon": 114.1,
      "distance_km": 12.4
    }
  ]
}
```

**預期回應 200（無警報）**

```json
{
  "meta": {
    "fetched_at": "2026-05-03T08:00:00.000Z",
    "lat": 22.3193,
    "lon": 114.1694,
    "radius_km": 100
  },
  "alerts": []
}
```

---

## API 5：Risk — 環境風險

### `GET /wx/risk` — 風險等級

輸出風險等級與原因（預報 + 附近警報共同計算）。

**Query 參數**

| 參數 | 必填 | 說明 | 預設 |
|---|---|---|---|
| `lat` / `lon` | ✅ | 座標 | — |
| `place_id` | ✅ | 位置 ID | — |
| `window_hours` | — | 1–72 | 24 |
| `radius_km` | — | 1–300 | 50 |

**範例**

```bash
curl "$BASE/wx-risk?lat=22.3193&lon=114.1694&window_hours=24"
```

**預期回應 200**

```json
{
  "meta": {
    "fetched_at": "2026-05-03T08:00:00.000Z",
    "lat": 22.3193,
    "lon": 114.1694,
    "window_hours": 24,
    "radius_km": 50
  },
  "risk_level": 2,
  "risk_label": "Warning",
  "reasons": [
    {
      "code": "strong_wind",
      "label": "Strong wind forecast (gust up to 14.3 m/s)",
      "severity": 2
    },
    {
      "code": "heavy_rain_prob",
      "label": "Heavy rain probability 65% within window",
      "severity": 1
    }
  ]
}
```

**risk_level 定義**

| 值 | 標籤 | 說明 |
|---|---|---|
| 0 | Normal | 無明顯風險 |
| 1 | Watch | 輕度注意 |
| 2 | Warning | 中度警戒 |
| 3 | Danger | 高風險 |

---

## API 6：Environment Timeline — 環境變化時間軸

### `GET /wx-environment-timeline` — 全時間粒度時間軸

提供全球通用環境變化時間軸，含分鐘/小時/日多粒度預報與風險評估。

**Query 參數**

| 參數 | 必填 | 說明 | 預設 |
|---|---|---|---|
| `lat` / `lon` | ✅ | 座標 | — |
| `place_id` | ✅ | 位置 ID | — |
| `window_hours` | — | 1–168 | 72 |
| `minute_window` | — | 5–180 | 60 |
| `days` | — | 1–16 | 7 |
| `radius_km` | — | 1–500 | 50 |
| `provider` | — | `auto \| open_meteo \| met_norway \| pirate_weather \| weatherapi \| tomorrow_io \| openweather` | `auto` |
| `allow_live_fetch` | — | 是否允許即時抓取 | `true` |

> **分鐘級資料來源（v1.0.0）**：`minute[]` 使用 Open-Meteo `minutely_15` Nowcasting 端點，15 分鐘粒度，降雨強度為 mm/h（由原始 15min 值 ×4 換算）。

**範例**

```bash
curl "$BASE/wx-environment-timeline?lat=22.3193&lon=114.1694&window_hours=48&days=5"
```

**預期回應 200**

```json
{
  "meta": {
    "fetched_at": "2026-05-03T08:00:00.000Z",
    "provider": "open_meteo",
    "timezone": "Asia/Hong_Kong",
    "lat": 22.3193,
    "lon": 114.1694,
    "geohash": "wei3",
    "window_hours": 48,
    "days": 5,
    "minute_window": 60,
    "radius_km": 50,
    "country_code": "HK",
    "name": "Hong Kong"
  },
  "alerts_summary": {
    "active_count": 0
  },
  "now": {
    "observed": {
      "temp_c": 27.2,
      "humidity_pct": 79,
      "wind_speed_ms": 4.1,
      "precip_mm": 0.0,
      "weather_code": 2
    },
    "risk": {
      "level": 0,
      "label": "Normal",
      "reasons": []
    }
  },
  "minute": [
    {
      "valid_time": "2026-05-03T08:00:00Z",
      "temp_c": 27.2,
      "humidity_pct": 79,
      "precip_prob": 5,
      "wind_ms": 4.1,
      "gust_ms": 7.2,
      "risk": { "level": 0, "reasons": [] }
    }
    // ... 最多 minute_window 分鐘
  ],
  "hourly": [
    {
      "valid_time": "2026-05-03T08:00:00Z",
      "temp_c": 27.4,
      "apparent_temp_c": 30.1,
      "humidity_pct": 80,
      "precip_mm": 0.0,
      "precip_prob": 5,
      "wind_speed_ms": 4.2,
      "wind_gust_ms": 7.8,
      "cloud_pct": 45,
      "uv_index": 6.3,
      "weather_code": 2,
      "risk": { "level": 0, "reasons": [] }
    }
    // ... 最多 window_hours 筆
  ],
  "daily": [
    {
      "date": "2026-05-03",
      "temp_min_c": 23.8,
      "temp_max_c": 29.5,
      "precip_sum_mm": 1.2,
      "precip_prob_max": 30,
      "wind_max_ms": 9.3,
      "uv_index_max": 8.5,
      "weather_code": 61,
      "risk": { "level": 1, "reasons": ["heavy_rain_prob"] }
    }
    // ... 最多 days 筆
  ]
}
```

**risk.reasons 可能值**

| 代碼 | 說明 |
|---|---|
| `heat_extreme` | 極端高溫（≥ 37°C） |
| `cold_extreme` | 極端低溫（≤ -10°C） |
| `dry_air` | 相對濕度 < 30% |
| `humidity_gt_90` | 相對濕度 > 90% |
| `heavy_rain_prob` | 強降雨機率高 |
| `strong_wind` | 風速 / 陣風超標 |
| `storm_condition` | 雷暴條件 |
| `official_alert` | 官方警報加權 |

---

## API 7：Country / Region — 國家地區資料

### `GET /wx-country-today` — 國家所有地區今日資料

按 `country_code` 回傳「該國已建索引地區」的本日資料（含分頁）。

**Query 參數**

| 參數 | 必填 | 說明 | 預設 |
|---|---|---|---|
| `country_code` | ✅ | ISO-3166-1 alpha-2 | — |
| `page` | — | >= 1 | 1 |
| `page_size` | — | 1–500 | 100 |
| `include` | — | `summary,risk,alerts` | `summary,risk` |
| `radius_km` | — | 1–500 | 50 |

**範例**

```bash
curl "$BASE/wx-country-today?country_code=HK&include=summary,risk,alerts"
```

**預期回應 200**

```json
{
  "meta": {
    "country_code": "HK",
    "date": "2026-05-03",
    "page": 1,
    "page_size": 100,
    "total_regions": 18,
    "total_pages": 1,
    "include": ["summary", "risk", "alerts"],
    "fetched_at": "2026-05-03T08:00:00.000Z"
  },
  "regions": [
    {
      "region_code": "HK-KO",
      "region_name": "Kowloon",
      "lat": 22.3167,
      "lon": 114.1833,
      "timezone": "Asia/Hong_Kong",
      "observed": {
        "temp_c": 27.1,
        "humidity_pct": 80,
        "wind_speed_ms": 4.0,
        "weather_code": 2
      },
      "today": {
        "temp_min_c": 23.5,
        "temp_max_c": 29.3,
        "precip_sum_mm": 0.8,
        "precip_prob_max": 25
      },
      "risk": {
        "level": 0,
        "label": "Normal",
        "reasons": []
      },
      "active_alert_count": 0
    }
    // ... 更多地區
  ]
}
```

---

### `GET /wx-region` — 單一地區詳細資料

以 `country_code + region_code` 查單一地區詳細資料，支援粒度控制。

**Query 參數**

| 參數 | 必填 | 說明 | 預設 |
|---|---|---|---|
| `country_code` | ✅ | ISO-3166-1 alpha-2 | — |
| `region_code` | ✅ | 地區代碼 | — |
| `granularity` | — | `all \| minute \| hourly \| daily` | `all` |
| `minute_window` | — | 5–180 | 60 |
| `hours` | — | 1–168 | 72 |
| `days` | — | 1–16 | 7 |
| `window_hours` | — | 1–168 | 24 |
| `radius_km` | — | 1–500 | 50 |
| `provider` | — | `auto \| open_meteo \| met_norway \| pirate_weather \| weatherapi \| tomorrow_io \| openweather` | `auto` |
| `allow_live_fetch` | — | 是否即時抓取 | `true` |

**範例**

```bash
curl "$BASE/wx-region?country_code=HK&region_code=HK-KO&granularity=hourly&hours=24"
```

**預期回應 200**

```json
{
  "meta": {
    "country_code": "HK",
    "region_code": "HK-KO",
    "region_name": "Kowloon",
    "granularity": "hourly",
    "timezone": "Asia/Hong_Kong",
    "lat": 22.3167,
    "lon": 114.1833,
    "fetched_at": "2026-05-03T08:00:00.000Z"
  },
  "now": {
    "observed": {
      "temp_c": 27.1,
      "humidity_pct": 80,
      "wind_speed_ms": 4.0,
      "weather_code": 2
    },
    "risk": { "level": 0, "label": "Normal", "reasons": [] }
  },
  "alerts_summary": { "active_count": 0 },
  "alerts": [],
  "hourly": [
    {
      "valid_time": "2026-05-03T08:00:00Z",
      "temp_c": 27.3,
      "humidity_pct": 79,
      "precip_prob": 5,
      "wind_speed_ms": 4.1,
      "weather_code": 2
    }
    // ...
  ]
}
```

---

### `GET /wx-region-coverage` — 地區覆蓋健康檢查

查詢 `wx_region_codes` 覆蓋率與同步健康狀態。

**Query 參數**

| 參數 | 必填 | 說明 |
|---|---|---|
| `country_code` | — | 不傳則回傳所有已有 region 的國家 |

**範例**

```bash
# 查所有國家
curl "$BASE/wx-region-coverage"

# 只查香港
curl "$BASE/wx-region-coverage?country_code=HK"
```

**預期回應 200**

```json
{
  "meta": {
    "country_count": 42,
    "total_region_count": 1284,
    "total_seed_count": 312,
    "total_hotspot_count": 720,
    "total_source_location_count": 252,
    "latest_region_updated_at": "2026-05-03T07:00:00.000Z",
    "fetched_at": "2026-05-03T08:00:00.000Z"
  },
  "countries": [
    {
      "country_code": "HK",
      "region_count": 18,
      "seed_count": 18,
      "location_count": 0,
      "hotspot_count": 0,
      "other_count": 0,
      "source_location_count": 18,
      "coverage_ratio": 1.0,
      "latest_updated_at": "2026-05-03T06:00:00.000Z",
      "sample_regions": ["HK-KO", "HK-NT", "HK-HK"]
    }
    // ...
  ]
}
```

---

## 可用國家 / 地區清單（Country & Region Coverage）

> 資料來源：`GET /wx-region-coverage`，測試時間：2026-05-03  
> **40 個國家，93 個地區**已建立索引。其中 **38 個國家**有即時天氣資料，2 個（MO、AE）地區已建立但尚未完成首次資料預取。

### 圖例

| 符號 | 說明 |
|---|---|
| ✅ | 有即時觀測 + 今日預報資料 |
| ⚠️ | 地區已建立索引，但尚無快取資料（首次查詢會觸發 live fetch） |

---

### 亞洲

| country_code | 國家 | 地區數 | 已覆蓋城市 / 地區 | 狀態 |
|---|---|---|---|---|
| `HK` | 香港 | 1 | Hong Kong Central | ✅ |
| `MO` | 澳門 | 1 | Macau Urban | ⚠️ |
| `TW` | 台灣 | 2 | Taipei City、Xinyi District | ✅ |
| `CN` | 中國 | 11 | Beijing、Shenzhen Nanshan、Shanghai（Jing'ansi）、Guangzhou、Wansong 等 | ✅ |
| `JP` | 日本 | 3 | Tokyo Chiyoda、Chiyoda、Osaka | ✅ |
| `KR` | 韓國 | 2 | Seoul Jung-gu、Euljiro-dong | ✅ |
| `SG` | 新加坡 | 2 | Singapore、Singapore Central | ✅ |
| `IN` | 印度 | 11 | Mumbai、Delhi（Civil Lines）、Kolkata、Chennai、Bengaluru 等 | ✅ |
| `BD` | 孟加拉 | 2 | Dhaka、Chattogram | ✅ |
| `PK` | 巴基斯坦 | 2 | Karachi Division、Punjab | ✅ |
| `TH` | 泰國 | 1 | Bangkok（Pom Prap Sattru Phai） | ✅ |
| `VN` | 越南 | 2 | Ho Chi Minh City、Hanoi（Hoan Kiem） | ✅ |
| `ID` | 印尼 | 1 | Jakarta（Gambir） | ✅ |
| `PH` | 菲律賓 | 1 | Manila（Santa Cruz） | ✅ |
| `MM` | 緬甸 | 1 | Yangon（Mingala Taungnyunt） | ✅ |
| `IR` | 伊朗 | 1 | Tehran | ✅ |
| `IQ` | 伊拉克 | 1 | Baghdad（Al Rasheed） | ✅ |
| `SA` | 沙烏地阿拉伯 | 1 | Riyadh | ✅ |
| `AE` | 阿聯酋 | 1 | Dubai Centre | ⚠️ |

### 歐洲

| country_code | 國家 | 地區數 | 已覆蓋城市 / 地區 | 狀態 |
|---|---|---|---|---|
| `GB` | 英國 | 2 | London Westminster、Greater London | ✅ |
| `FR` | 法國 | 2 | Paris、Paris Centre | ✅ |
| `DE` | 德國 | 1 | Berlin Mitte | ✅ |
| `ES` | 西班牙 | 2 | Madrid、Barcelona | ✅ |
| `TR` | 土耳其 | 2 | Istanbul（Hobyar Mahallesi、Hacettepe Mahallesi） | ✅ |
| `RU` | 俄羅斯 | 2 | Moscow、Saint Petersburg | ✅ |

### 美洲

| country_code | 國家 | 地區數 | 已覆蓋城市 / 地區 | 狀態 |
|---|---|---|---|---|
| `US` | 美國 | 12 | New York Manhattan、Los Angeles、Chicago、Miami、Atlanta、Boston、Houston、Dallas、Philadelphia、Phoenix、San Antonio、San Diego | ✅ |
| `CA` | 加拿大 | 1 | Toronto | ✅ |
| `MX` | 墨西哥 | 2 | Mexico City（Cuauhtémoc）、Guadalajara | ✅ |
| `BR` | 巴西 | 6 | São Paulo、Rio de Janeiro、Minas Gerais、São Paulo Centro、Rio Grande do Sul 等 | ✅ |
| `AR` | 阿根廷 | 1 | Buenos Aires | ✅ |
| `CL` | 智利 | 1 | Santiago | ✅ |
| `CO` | 哥倫比亞 | 1 | Bogotá（Los Mártires） | ✅ |
| `PE` | 秘魯 | 1 | Lima | ✅ |

### 大洋洲

| country_code | 國家 | 地區數 | 已覆蓋城市 / 地區 | 狀態 |
|---|---|---|---|---|
| `AU` | 澳洲 | 3 | Sydney、Sydney CBD、Melbourne | ✅ |

### 非洲

| country_code | 國家 | 地區數 | 已覆蓋城市 / 地區 | 狀態 |
|---|---|---|---|---|
| `EG` | 埃及 | 2 | Cairo、Alexandria | ✅ |
| `NG` | 奈及利亞 | 1 | Lagos | ✅ |
| `AO` | 安哥拉 | 1 | Luanda | ✅ |
| `CD` | 剛果（民主共和國） | 1 | Kinshasa（Djalo） | ✅ |
| `CI` | 科特迪瓦 | 1 | Abidjan（Le Plateau） | ✅ |
| `SD` | 蘇丹 | 1 | Khartoum | ✅ |

---

### 使用範例

**查詢某國所有地區今日天氣**

```bash
# 美國（12 個地區）
curl "$BASE/wx-country-today?country_code=US"

# 中國（11 個地區）
curl "$BASE/wx-country-today?country_code=CN"

# 香港（1 個地區）
curl "$BASE/wx-country-today?country_code=HK"
```

**查詢單一地區詳細天氣**

```bash
# 香港 Central
curl "$BASE/wx-region?country_code=HK&region_code=hong-kong-central-wecnyk"

# 東京 Chiyoda
curl "$BASE/wx-region?country_code=JP&region_code=tokyo-chiyoda-xn774c"

# 紐約 Manhattan
curl "$BASE/wx-region?country_code=US&region_code=new-york-manhattan-dr5reg"

# 倫敦 Westminster
curl "$BASE/wx-region?country_code=GB&region_code=london-westminster-gcpvj0"

# 台北市
curl "$BASE/wx-region?country_code=TW&region_code=taipei-city-wsqqqq"

# 新加坡
curl "$BASE/wx-region?country_code=SG&region_code=singapore-w21z77"
```

**取得覆蓋率報告**

```bash
# 全部國家
curl "$BASE/wx-region-coverage"

# 指定國家
curl "$BASE/wx-region-coverage?country_code=US"
```

> 地區資料每 30 分鐘由 `pg_cron` 自動同步（`novaweather_sync_region_codes`）。  
> 若需新增城市，可透過 `POST /wx-sync-region-codes` 手動觸發同步，或直接以 `lat/lon` 呼叫任意天氣端點（會自動建立地點索引）。

---

## API 8：Air Quality — 空氣質素

### `GET /wx-air-quality` — 小時級空氣質素預報

取得指定座標的小時級空氣質素預報（Open-Meteo Air Quality API）。

**Query 參數**

| 參數 | 必填 | 說明 | 預設 |
|---|---|---|---|
| `lat` | ✅ | 緯度 | — |
| `lon` | ✅ | 經度 | — |
| `hours` | — | 1–120 | 48 |

**範例**

```bash
curl "$BASE/wx-air-quality?lat=22.3193&lon=114.1694&hours=24"
```

**預期回應 200**

```json
{
  "meta": {
    "lat": 22.3193,
    "lon": 114.1694,
    "geohash": "wei3",
    "hours": 24,
    "provider": "open_meteo_aq",
    "timezone": "Asia/Hong_Kong",
    "fetched_at": "2026-05-03T08:00:00.000Z",
    "upstream_latency_ms": 387
  },
  "hourly": [
    {
      "valid_time": "2026-05-03T08:00:00Z",
      "pm10": 24.3,
      "pm2_5": 11.7,
      "carbon_monoxide": 201.4,
      "nitrogen_dioxide": 18.2,
      "sulphur_dioxide": 2.1,
      "ozone": 68.5,
      "aerosol_optical_depth": 0.12,
      "dust": 4.3,
      "uv_index": 6.3,
      "uv_index_clear_sky": 7.1,
      "alder_pollen": null,
      "birch_pollen": null,
      "grass_pollen": 3.2,
      "mugwort_pollen": null,
      "olive_pollen": null,
      "ragweed_pollen": null,
      "us_aqi": 48,
      "european_aqi": 27
    }
    // ...
  ]
}
```

**AQI 等級（US AQI）**

| 範圍 | 等級 | 顏色 |
|---|---|---|
| 0–50 | Good | 綠 |
| 51–100 | Moderate | 黃 |
| 101–150 | Unhealthy for Sensitive Groups | 橙 |
| 151–200 | Unhealthy | 紅 |
| 201–300 | Very Unhealthy | 紫 |
| 301+ | Hazardous | 褐紅 |

---

## API 9：METAR Observations — 機場實況觀測

### `GET /wx-observed-metar` — 機場 METAR 查詢

查詢全球主要機場 METAR 觀測資料（NOAA Aviation Weather Center，35 個全球優先站）。

**Query 參數**

| 參數 | 必填 | 說明 | 預設 |
|---|---|---|---|
| `lat` / `lon` | — | 若提供，僅回傳範圍內觀測站 | — |
| `radius_km` | — | 過濾半徑 | 100 |

**範例**

```bash
# 查詢香港附近 200km 內的 METAR 站
curl "$BASE/wx-observed-metar?lat=22.3193&lon=114.1694&radius_km=200"

# 查詢所有 35 個全球優先站
curl "$BASE/wx-observed-metar"
```

**預期回應 200**

```json
{
  "meta": {
    "lat": 22.3193,
    "lon": 114.1694,
    "radius_km": 200,
    "since": "2026-05-03T07:00:00.000Z"
  },
  "observations": [
    {
      "station_id": "VHHH",
      "geohash": "wei3",
      "lat": 22.308,
      "lon": 113.918,
      "elevation_m": 9,
      "observation_time": "2026-05-03T07:30:00Z",
      "temp_c": 26.8,
      "dewpoint_c": 22.6,
      "humidity_pct": 79,
      "wind_dir_deg": 130,
      "wind_speed_ms": 5.1,
      "wind_gust_ms": 9.3,
      "visibility_m": 9999,
      "pressure_hpa": 1009.0,
      "pressure_sea_level_hpa": 1009.4,
      "weather_code": "FEW020",
      "raw_metar": "VHHH 030730Z 13010KT 9999 FEW020 27/23 Q1009 NOSIG"
    },
    {
      "station_id": "ZGGG",
      "geohash": "ws0e",
      "lat": 23.392,
      "lon": 113.299,
      "elevation_m": 15,
      "observation_time": "2026-05-03T07:30:00Z",
      "temp_c": 27.4,
      "dewpoint_c": 23.1,
      "humidity_pct": 80,
      "wind_dir_deg": 150,
      "wind_speed_ms": 3.6,
      "wind_gust_ms": null,
      "visibility_m": 9999,
      "pressure_hpa": 1008.5,
      "pressure_sea_level_hpa": 1009.1,
      "weather_code": "SCT025",
      "raw_metar": "ZGGG 030730Z 15007KT 9999 SCT025 27/23 Q1009"
    }
  ]
}
```

---

## API 10：Service Status — 服務健康

### `GET /wx-status` — 系統健康檢查

回傳系統整體健康狀態、資料新鮮度、供應商健康度與警報地理覆蓋率。

**範例**

```bash
curl "$BASE/wx-status"
```

**預期回應 200**

```json
{
  "ok": true,
  "checked_at": "2026-05-03T08:00:00.000Z",
  "data_freshness": {
    "wx_cache_latest": "2026-05-03T07:58:00.000Z",
    "wx_air_quality_latest": "2026-05-03T07:45:00.000Z",
    "wx_metar_latest": "2026-05-03T07:30:00.000Z"
  },
  "counts": {
    "hotspots": 524,
    "region_codes": 1284,
    "alerts_24h_by_source": {
      "HKO": 2,
      "NWS": 41,
      "SMG": 0,
      "CAP": 8
    }
  },
  "alerts_geo_coverage": {
    "with_geo": 49,
    "without_geo": 2,
    "pct_geo": 96.1
  },
  "provider_health": [
    {
      "provider": "open_meteo",
      "success_rate_15m": 0.99,
      "p95_latency_ms": 412,
      "last_run_at": "2026-05-03T07:55:00.000Z"
    },
    {
      "provider": "weatherapi",
      "success_rate_15m": 0.97,
      "p95_latency_ms": 580,
      "last_run_at": "2026-05-03T07:55:00.000Z"
    }
  ],
  "ingest_last_1h": {
    "open_meteo": { "ok": 12, "error": 0, "last_run": "2026-05-03T07:58:00.000Z" },
    "weatherapi": { "ok": 11, "error": 1, "last_run": "2026-05-03T07:55:00.000Z" }
  }
}
```

---

## API 11：Marine — 海洋預報

### `GET /wx-marine` — 海洋波浪 / 海流 / 海溫

海洋波浪 + 海流 + 海溫預報（僅沿海/離島座標有效，內陸回 400）。

**Query 參數**

| 參數 | 必填 | 說明 | 預設 |
|---|---|---|---|
| `lat` | ✅ | 緯度 | — |
| `lon` | ✅ | 經度 | — |
| `forecast_days` | — | 1–7 | 3 |

**範例**

```bash
# 香港南部海域
curl "$BASE/wx-marine?lat=22.2&lon=114.1&forecast_days=3"
```

**預期回應 200**

```json
{
  "meta": {
    "lat": 22.2,
    "lon": 114.1,
    "geohash": "wei1",
    "provider": "open_meteo_marine",
    "fetched_at": "2026-05-03T08:00:00.000Z"
  },
  "hourly": [
    {
      "time": "2026-05-03T08:00:00Z",
      "wave_height_m": 0.8,
      "wave_direction_deg": 142,
      "wave_period_s": 6.2,
      "wind_wave_height_m": 0.5,
      "wind_wave_direction_deg": 138,
      "wind_wave_period_s": 4.1,
      "swell_wave_height_m": 0.4,
      "swell_wave_direction_deg": 158,
      "swell_wave_period_s": 9.3,
      "sea_surface_temperature_c": 25.8,
      "ocean_current_velocity_ms": 0.21,
      "ocean_current_direction_deg": 210
    }
    // ...
  ],
  "daily": [
    {
      "date": "2026-05-03",
      "wave_height_max_m": 1.2,
      "wave_direction_dominant_deg": 145,
      "wave_period_max_s": 7.4,
      "wind_wave_height_max_m": 0.8,
      "swell_wave_height_max_m": 0.6
    }
    // ...
  ]
}
```

**錯誤：內陸座標**

```json
HTTP 400
{ "error": "Inland location", "detail": "Open-Meteo Marine does not cover this coordinate" }
```

---

## API 12：Solar Radiation — 太陽輻射

### `GET /wx-solar` — 太陽輻射預報

每小時太陽輻射 + 每日日出日落與輻射總量（Open-Meteo Solar）。

**Query 參數**

| 參數 | 必填 | 說明 | 預設 |
|---|---|---|---|
| `lat` | ✅ | 緯度 | — |
| `lon` | ✅ | 經度 | — |
| `forecast_days` | — | 1–16 | 7 |
| `tilt` | — | 面板傾角 deg，影響 `global_tilted_irradiance` | 0 |
| `azimuth` | — | 面板方位 deg | 0 |

**範例**

```bash
# 計算朝南傾斜 20° 太陽能面板
curl "$BASE/wx-solar?lat=22.3193&lon=114.1694&forecast_days=3&tilt=20&azimuth=180"
```

**預期回應 200**

```json
{
  "meta": {
    "lat": 22.3193,
    "lon": 114.1694,
    "provider": "open_meteo_solar",
    "fetched_at": "2026-05-03T08:00:00.000Z"
  },
  "hourly": [
    {
      "time": "2026-05-03T08:00:00Z",
      "shortwave_radiation_w_m2": 412.5,
      "direct_radiation_w_m2": 298.1,
      "diffuse_radiation_w_m2": 114.4,
      "direct_normal_irradiance_w_m2": 521.3,
      "global_tilted_irradiance_w_m2": 448.7,
      "terrestrial_radiation_w_m2": 490.2
    }
    // ...
  ],
  "daily": [
    {
      "date": "2026-05-03",
      "sunrise_utc": "21:52",
      "sunset_utc": "11:03",
      "daylight_duration_s": 47460,
      "sunshine_duration_s": 32100,
      "shortwave_radiation_sum_mj_m2": 18.4
    }
    // ...
  ]
}
```

---

## API 13：Historical Archive — 歷史天氣

### `GET /wx-historical` — 歷史天氣存檔

1940 年至今的歷史天氣存檔（Open-Meteo Archive API）。

**Query 參數**

| 參數 | 必填 | 說明 | 預設 |
|---|---|---|---|
| `lat` | ✅ | 緯度 | — |
| `lon` | ✅ | 經度 | — |
| `start_date` | ✅ | YYYY-MM-DD（≤ 昨天） | — |
| `end_date` | ✅ | YYYY-MM-DD（≤ 昨天） | — |
| `granularity` | — | `hourly`（最長 366 天）\| `daily`（最長 3650 天） | `daily` |
| `variables` | — | 逗號分隔 Open-Meteo 變數名 | 預設集 |

**範例**

```bash
# 查詢香港過去一週日級歷史資料
curl "$BASE/wx-historical?lat=22.3193&lon=114.1694&start_date=2026-04-26&end_date=2026-05-02"

# 查詢小時級資料（指定特定變數）
curl "$BASE/wx-historical?lat=22.3193&lon=114.1694&start_date=2026-04-30&end_date=2026-05-01&granularity=hourly&variables=temperature_2m,precipitation,wind_speed_10m"
```

**預期回應 200（daily）**

```json
{
  "meta": {
    "lat": 22.3193,
    "lon": 114.1694,
    "start_date": "2026-04-26",
    "end_date": "2026-05-02",
    "granularity": "daily",
    "provider": "open_meteo_archive",
    "source_url": "https://archive-api.open-meteo.com/v1/archive?..."
  },
  "data": [
    {
      "date": "2026-04-26",
      "temp_min_c": 21.3,
      "temp_max_c": 27.8,
      "precip_sum_mm": 3.5,
      "wind_max_ms": 8.1,
      "shortwave_radiation_sum_mj_m2": 14.2
    },
    {
      "date": "2026-04-27",
      "temp_min_c": 22.0,
      "temp_max_c": 28.4,
      "precip_sum_mm": 0.0,
      "wind_max_ms": 6.9,
      "shortwave_radiation_sum_mj_m2": 17.6
    }
    // ...
  ]
}
```

**回應 Headers**

```
cache-control: public, max-age=3600
```

**錯誤：日期範圍超限**

```json
HTTP 400
{ "error": "Date range too long", "detail": "hourly granularity supports max 366 days" }
```

---

## API 14：Astronomy — 天文曆

### `GET /wx-astronomy` — 日出 / 日落 / 月相

純計算日出/日落/晨昏蒙影/月相（無外部 API，延遲極低）。

**Query 參數**

| 參數 | 必填 | 說明 | 預設 |
|---|---|---|---|
| `lat` | ✅ | 緯度 | — |
| `lon` | ✅ | 經度 | — |
| `date` | — | 起始日 YYYY-MM-DD | 今天 |
| `days` | — | 1–30 | 7 |

**範例**

```bash
curl "$BASE/wx-astronomy?lat=22.3193&lon=114.1694&date=2026-05-03&days=3"
```

**預期回應 200**

```json
{
  "meta": {
    "lat": 22.3193,
    "lon": 114.1694,
    "date": "2026-05-03",
    "days": 3,
    "fetched_at": "2026-05-03T08:00:00.000Z"
  },
  "astronomy": [
    {
      "date": "2026-05-03",
      "sunrise_utc": "21:53",
      "sunset_utc": "11:02",
      "civil_dawn_utc": "21:27",
      "civil_dusk_utc": "11:28",
      "nautical_dawn_utc": "20:55",
      "nautical_dusk_utc": "12:00",
      "astronomical_dawn_utc": "20:22",
      "astronomical_dusk_utc": "12:33",
      "moon_phase": "Waxing Gibbous",
      "moon_illumination_pct": 68.4,
      "uv_estimate": 8.2
    },
    {
      "date": "2026-05-04",
      "sunrise_utc": "21:52",
      "sunset_utc": "11:03",
      "civil_dawn_utc": "21:26",
      "civil_dusk_utc": "11:29",
      "nautical_dawn_utc": "20:54",
      "nautical_dusk_utc": "12:01",
      "astronomical_dawn_utc": "20:21",
      "astronomical_dusk_utc": "12:34",
      "moon_phase": "Waxing Gibbous",
      "moon_illumination_pct": 77.1,
      "uv_estimate": 8.4
    },
    {
      "date": "2026-05-05",
      "sunrise_utc": "21:51",
      "sunset_utc": "11:04",
      "civil_dawn_utc": "21:25",
      "civil_dusk_utc": "11:30",
      "nautical_dawn_utc": "20:53",
      "nautical_dusk_utc": "12:02",
      "astronomical_dawn_utc": "20:20",
      "astronomical_dusk_utc": "12:35",
      "moon_phase": "Full Moon",
      "moon_illumination_pct": 98.2,
      "uv_estimate": 8.5
    }
  ]
}
```

**moon_phase 可能值**

`New Moon` / `Waxing Crescent` / `First Quarter` / `Waxing Gibbous` / `Full Moon` / `Waning Gibbous` / `Last Quarter` / `Waning Crescent`

> 所有時間為 **UTC**（`HH:MM`）；高緯度極晝/極夜無日出/日落時該欄為 `null`。

---

## API 15：Bundle — 聚合請求

### `GET /wx-bundle` — 單請求並行多資料集

單請求並行抓取多個 wx-* 資料集，適合行動端減少 round-trip。

**Query 參數**

| 參數 | 必填 | 說明 | 預設 |
|---|---|---|---|
| `lat` | ✅ | 緯度 | — |
| `lon` | ✅ | 經度 | — |
| `include` | — | 逗號分隔資料集鍵名 | `forecast_hourly,forecast_daily,observed,aq,alerts,risk` |

**可用鍵名**

`forecast_hourly` \| `forecast_daily` \| `observed` \| `aq` \| `marine` \| `alerts` \| `risk` \| `astronomy` \| `metar` \| `solar` \| `environment`

> 其他參數（如 `forecast_days`、`place_id`、`hours`）會自動轉發給各子請求。

**範例**

```bash
# 一次抓取：即時觀測 + 24小時預報 + 空氣質素 + 天文
curl "$BASE/wx-bundle?lat=22.3193&lon=114.1694&include=observed,forecast_hourly,aq,astronomy&hours=24"
```

**預期回應 200**

```json
{
  "meta": {
    "lat": 22.3193,
    "lon": 114.1694,
    "include": ["observed", "forecast_hourly", "aq", "astronomy"],
    "elapsed_ms": 621,
    "fetched_at": "2026-05-03T08:00:00.000Z"
  },
  "data": {
    "observed": {
      "meta": { "fetched_at": "...", "lat": 22.3193, "lon": 114.1694 },
      "observed": { "temp_c": 27.2, "humidity_pct": 79 }
    },
    "forecast_hourly": {
      "meta": { "provider": "open_meteo", "hours": 24 },
      "hourly": [ /* ... */ ]
    },
    "aq": {
      "meta": { "provider": "open_meteo_aq", "hours": 24 },
      "hourly": [ /* ... */ ]
    },
    "astronomy": {
      "meta": { "days": 7 },
      "astronomy": [ /* ... */ ]
    }
  },
  "errors": {}
}
```

**部分失敗範例**

```json
{
  "meta": { "elapsed_ms": 1203, "include": ["observed", "marine"] },
  "data": {
    "observed": { "observed": { "temp_c": 27.2 } }
  },
  "errors": {
    "marine": { "status": 400, "error": "Inland location" }
  }
}
```

---

## API 16：Indices — 複合天氣指數

### `GET /wx-indices` — 舒適度 / 健康 / 戶外 / 能源指數

基於 Open-Meteo 即時預報計算複合天氣指數（無需額外 API key 費用）。

**Query 參數**

| 參數 | 必填 | 說明 |
|---|---|---|
| `lat` | ✅ | 緯度 |
| `lon` | ✅ | 經度 |

**範例**

```bash
curl "$BASE/wx-indices?lat=22.3193&lon=114.1694"
```

**預期回應 200**

```json
{
  "meta": {
    "lat": 22.3193,
    "lon": 114.1694,
    "fetched_at": "2026-05-03T08:00:00.000Z",
    "provider": "open_meteo"
  },
  "current": {
    "temp_c": 27.4,
    "apparent_temp_c": 30.1,
    "humidity_pct": 80,
    "wind_ms": 4.2,
    "cloud_pct": 45,
    "uv_index": 6.3,
    "uv_category": "High",
    "us_aqi": 48,
    "heat_index_c": 31.2,
    "wind_chill_c": null,
    "frost_risk": "Low",
    "heat_risk": "Low"
  },
  "indices": {
    "comfort": {
      "score": 62,
      "label": "Slightly Uncomfortable"
    },
    "health": {
      "score": 71,
      "label": "Good",
      "risks": ["high_humidity"]
    },
    "outdoor": {
      "score": 68,
      "label": "Mostly Suitable"
    },
    "energy": {
      "cooling_demand": 5.4,
      "heating_demand": 0.0,
      "solar_potential": "High"
    }
  },
  "hourly": [
    {
      "time": "2026-05-03T08:00:00Z",
      "comfort": 62,
      "outdoor": 68,
      "uv_index": 6.3,
      "uv_category": "High"
    },
    {
      "time": "2026-05-03T09:00:00Z",
      "comfort": 59,
      "outdoor": 65,
      "uv_index": 7.1,
      "uv_category": "High"
    }
    // ... 共 24 小時
  ]
}
```

**指數說明**

| 指數 | 計算邏輯 | 分數含義 |
|---|---|---|
| `comfort` | 溫度/濕度/風速三維加權 | 100 = 最舒適 |
| `health` | 懲罰熱壓力/冷壓力/高濕/高UV/空污 | 100 = 最健康 |
| `outdoor` | 降水機率/溫度/風/UV 戶外適宜度 | 100 = 最適合戶外 |
| `energy` | 度日數代理值（CDD/HDD 概念） | — |

**heat_index 計算（Rothfusz）**：僅在 t ≥ 27°C 時計算。  
**wind_chill 計算**：僅在 t ≤ 10°C 且風速 > 1.3 m/s 時計算。  
**frost_risk**：`Low` / `Moderate` / `High`（基於 t ≤ 3°C 閾值）。  
**heat_risk**：`Low` / `Moderate` / `High`（基於 t ≥ 33°C 閾值）。

```
cache-control: public, max-age=900
```

---

## API 17：Compare — 多地比較

### `GET /wx-compare` — 最多 5 個地點並行比較

一次請求比較最多 5 個地點的天氣（並行抓取），含 delta 差值分析。

**Query 參數**

| 參數 | 必填 | 說明 |
|---|---|---|
| `locations` | ✅ | `lat,lon[,label]|lat,lon[,label]|...`（pipe 分隔，最多 5 組） |

**範例**

```bash
curl "$BASE/wx-compare?locations=22.3193,114.1694,Hong%20Kong|35.6762,139.6503,Tokyo|48.8566,2.3522,Paris"
```

**預期回應 200**

```json
{
  "meta": {
    "fetched_at": "2026-05-03T08:00:00.000Z",
    "count": 3
  },
  "locations": [
    {
      "label": "Hong Kong",
      "lat": 22.3193,
      "lon": 114.1694,
      "timezone": "Asia/Hong_Kong",
      "current": {
        "temp_c": 27.4,
        "apparent_temp_c": 30.1,
        "humidity_pct": 80,
        "wind_ms": 4.2,
        "cloud_pct": 45,
        "uv_index": 6.3,
        "precip_mm": 0.0,
        "weather_code": 2
      },
      "daily": [
        {
          "date": "2026-05-03",
          "t_min_c": 23.8,
          "t_max_c": 29.5,
          "precip_sum_mm": 1.2,
          "precip_prob_max": 30,
          "wind_max_ms": 9.3,
          "uv_max": 8.5,
          "sunrise": "21:53",
          "sunset": "11:02"
        }
        // 共 3 天
      ]
    },
    {
      "label": "Tokyo",
      "lat": 35.6762,
      "lon": 139.6503,
      "timezone": "Asia/Tokyo",
      "current": {
        "temp_c": 18.2,
        "apparent_temp_c": 17.5,
        "humidity_pct": 55,
        "wind_ms": 3.8,
        "cloud_pct": 20,
        "uv_index": 3.1,
        "precip_mm": 0.0,
        "weather_code": 1
      },
      "daily": [
        {
          "date": "2026-05-03",
          "t_min_c": 14.1,
          "t_max_c": 21.6,
          "precip_sum_mm": 0.0,
          "precip_prob_max": 5,
          "wind_max_ms": 5.2,
          "uv_max": 5.8,
          "sunrise": "19:51",
          "sunset": "09:28"
        }
      ]
    },
    {
      "label": "Paris",
      "lat": 48.8566,
      "lon": 2.3522,
      "timezone": "Europe/Paris",
      "current": {
        "temp_c": 14.5,
        "apparent_temp_c": 12.8,
        "humidity_pct": 68,
        "wind_ms": 5.1,
        "cloud_pct": 70,
        "uv_index": 2.2,
        "precip_mm": 0.4,
        "weather_code": 51
      },
      "daily": [
        {
          "date": "2026-05-03",
          "t_min_c": 11.2,
          "t_max_c": 17.3,
          "precip_sum_mm": 5.8,
          "precip_prob_max": 65,
          "wind_max_ms": 8.4,
          "uv_max": 3.2,
          "sunrise": "04:02",
          "sunset": "19:48"
        }
      ]
    }
  ],
  "delta": {
    "temp_c": 9.2,
    "humidity_pct": 25,
    "wind_ms": 0.4,
    "uv_index": 3.2,
    "between": ["Hong Kong", "Tokyo"]
  },
  "errors": []
}
```

```
cache-control: public, max-age=600
```

---

## API 18：Anomaly — 氣候異常偵測

### `GET /wx-anomaly` — Z-score 氣候異常分析

將今日天氣與歷史 30 年常態比較，偵測統計異常（Open-Meteo Historical Archive 採樣）。

**Query 參數**

| 參數 | 必填 | 說明 |
|---|---|---|
| `lat` | ✅ | 緯度 |
| `lon` | ✅ | 經度 |

**演算法**：抓取採樣年份（1994/1999/2004/2009/2014/2019/2023）中與今日同一週期（±7 天窗口）的每日資料，計算 μ 與 σ，以 Z-score 判定異常程度。

**範例**

```bash
curl "$BASE/wx-anomaly?lat=22.3193&lon=114.1694"
```

**預期回應 200（正常）**

```json
{
  "meta": {
    "lat": 22.3193,
    "lon": 114.1694,
    "reference_date": "2026-05-03",
    "historical_years": [1994, 1999, 2004, 2009, 2014, 2019, 2023],
    "historical_window_days": 7,
    "sample_count": 98,
    "fetched_at": "2026-05-03T08:00:00.000Z"
  },
  "overall_anomaly": "Normal",
  "max_z_score": 0.8,
  "deviations": {
    "temp_min_c": {
      "current": 23.8,
      "normal": 23.1,
      "deviation": 0.7,
      "sigma": 1.2,
      "anomaly": "Normal"
    },
    "temp_max_c": {
      "current": 29.5,
      "normal": 28.6,
      "deviation": 0.9,
      "sigma": 1.4,
      "anomaly": "Normal"
    },
    "precip_mm": {
      "current": 1.2,
      "normal": 2.8,
      "deviation": -1.6,
      "sigma": 3.5,
      "anomaly": "Normal"
    }
  },
  "normals": {
    "temp_min_c": 23.1,
    "temp_max_c": 28.6,
    "precip_mm": 2.8,
    "wind_max_ms": 7.4
  }
}
```

**預期回應 200（異常）**

```json
{
  "overall_anomaly": "Anomalous",
  "max_z_score": 2.9,
  "deviations": {
    "temp_max_c": {
      "current": 34.8,
      "normal": 28.6,
      "deviation": 6.2,
      "sigma": 1.4,
      "anomaly": "Extreme anomaly"
    }
  }
}
```

**overall_anomaly 等級**

| 值 | Z-score 範圍 | 說明 |
|---|---|---|
| `Normal` | \|z\| < 1.5 | 在常態範圍內 |
| `Slightly anomalous` | 1.5 ≤ \|z\| < 2.0 | 輕微偏離常態 |
| `Anomalous` | 2.0 ≤ \|z\| < 3.0 | 明顯異常 |
| `Extreme anomaly` | \|z\| ≥ 3.0 | 極端異常 |

```
cache-control: public, max-age=3600
```

---

## API 19：Webhook — 事件推送訂閱

NovaWeather 支援 Webhook 讓你的後端在氣象事件發生時收到 HTTP POST 推送。v1.0.0 採用**雙層異步架構**：fanout 工作每 5 分鐘掃描事件並寫入佇列，worker 工作每 1 分鐘批次派送（支援指數退避重試）。詳見下方「Webhook 派送架構」。

**目前支援事件類型**

| 事件 | 說明 |
|---|---|
| `alert_new` | 有新的官方警報進入資料庫 |
| `risk_high` | 某地點的風險等級達到 2 或以上 |

---

### `POST /wx-webhook-register` — 建立訂閱

**Request Body（JSON）**

| 欄位 | 必填 | 說明 |
|---|---|---|
| `owner_key` | ✅ | 訂閱識別金鑰（自訂，用於後續管理） |
| `callback_url` | ✅ | 接收事件的 **HTTPS** URL |
| `event_types` | — | `["alert_new", "risk_high"]`，預設 `["alert_new"]` |
| `lat` / `lon` | — | 地理中心點；僅推送 `radius_km` 範圍內的事件 |
| `radius_km` | — | 1–5000，預設 50 |
| `secret` | — | HMAC-SHA256 簽名密鑰 |

**範例**

```bash
curl -X POST "$BASE/wx-webhook-register" \
  -H "content-type: application/json" \
  -d '{
    "owner_key": "my-app-secret-key-2026",
    "callback_url": "https://myapp.com/webhooks/weather",
    "event_types": ["alert_new", "risk_high"],
    "lat": 22.3193,
    "lon": 114.1694,
    "radius_km": 100,
    "secret": "webhook-signing-secret"
  }'
```

**預期回應 201**

```json
{
  "ok": true,
  "subscription": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "callback_url": "https://myapp.com/webhooks/weather",
    "event_types": ["alert_new", "risk_high"],
    "lat": 22.3193,
    "lon": 114.1694,
    "radius_km": 100,
    "active": true,
    "created_at": "2026-05-03T08:00:00.000Z",
    "fire_count": 0,
    "failure_count": 0
  }
}
```

> 每個 `owner_key` 最多 20 個活躍訂閱；`callback_url` 必須為 HTTPS。

---

### `GET /wx-webhook-register?owner_key=xxx` — 列出訂閱

**範例**

```bash
curl "$BASE/wx-webhook-register?owner_key=my-app-secret-key-2026"
```

**預期回應 200**

```json
{
  "subscriptions": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "callback_url": "https://myapp.com/webhooks/weather",
      "event_types": ["alert_new", "risk_high"],
      "lat": 22.3193,
      "lon": 114.1694,
      "radius_km": 100,
      "active": true,
      "created_at": "2026-05-03T08:00:00.000Z",
      "fire_count": 12,
      "failure_count": 0
    }
  ],
  "count": 1
}
```

---

### `DELETE /wx-webhook-register?id=xxx&owner_key=xxx` — 停用訂閱

**範例**

```bash
curl -X DELETE "$BASE/wx-webhook-register?id=550e8400-e29b-41d4-a716-446655440000&owner_key=my-app-secret-key-2026"
```

**預期回應 200**

```json
{
  "ok": true,
  "message": "Subscription deactivated"
}
```

---

### Webhook 派送格式

每次觸發向 `callback_url` 發送 HTTP POST：

**Headers**

```
content-type: application/json
x-wxhook-signature: sha256=a1b2c3d4e5f6...  (僅在設有 secret 時)
x-wxhook-subscription-id: 550e8400-e29b-41d4-a716-446655440000
```

**Body**

```json
{
  "subscription_id": "550e8400-e29b-41d4-a716-446655440000",
  "api_version": "v1",
  "fired_at": "2026-05-03T08:05:00.000Z",
  "events": [
    {
      "event_type": "alert_new",
      "data": {
        "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "source": "HKO",
        "event_type": "TYPHOON_SIGNAL",
        "severity": "Severe",
        "headline": "Typhoon Signal No. 3 is in force",
        "effective": "2026-05-03T06:00:00Z",
        "expires": "2026-05-03T14:00:00Z",
        "centroid_lat": 22.35,
        "centroid_lon": 114.1
      }
    }
  ]
}
```

**HMAC-SHA256 驗證**

```python
import hmac, hashlib

def verify_webhook(secret: str, body: str, signature_header: str) -> bool:
    expected = "sha256=" + hmac.new(
        secret.encode(), body.encode(), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature_header)
```

```javascript
const crypto = require('crypto');
function verify(secret, body, sigHeader) {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigHeader));
}
```

**自動停用規則**：連續失敗 ≥ 10 次的訂閱將自動停用（`active = false`）。

---

### Webhook 派送架構（v1.0.0 異步解耦）

v1.0.0 將 Webhook 派送從同步改為**雙層異步**架構，提升可靠性並支援指數退避重試：

| 元件 | Edge Function | 觸發方式 | 說明 |
|---|---|---|---|
| **Fanout** | `wx-webhook-fanout` | `pg_cron` 每 5 分鐘 | 掃描新事件 → 寫入 `wx_webhook_queue` |
| **Worker** | `wx-webhook-worker` | `pg_cron` 每 1 分鐘 | 認領 queue 任務 → HTTP POST → 更新派送狀態 |

**Fanout 邏輯**：
- 每次掃描過去 6 分鐘的新警報 / 高風險事件
- 比對訂閱的 `event_types` 與地理範圍（`radius_km`）
- 寫入 `wx_webhook_queue`（每筆訂閱 × 事件各一行）

**Worker 邏輯**：
- `SELECT ... FOR UPDATE SKIP LOCKED` 每次最多認領 50 筆
- HTTP POST 超時 8 秒；失敗後依指數退避排程重試（最多 10 次）
- 連續失敗 ≥ 10 次自動停用訂閱（`active = false`）

> **注意**：`wx-webhook-dispatch`（舊版同步派送）已在 v1.0.0 移除，勿再呼叫。

---

## API 20：維運 / 排程（POST）

以下端點會寫入 / 清理資料，**請只在安全環境**（pg_cron / Scheduler / 後端）以 `service_role` 呼叫。

### 熱點預取

```bash
# 刷新 wx_hotspots 的 hourly forecast
curl -X POST "$BASE/wx-refresh-hotspots-hourly" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"

# 刷新 wx_hotspots 的 daily forecast
curl -X POST "$BASE/wx-refresh-hotspots-daily" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"

# 刷新 wx_hotspots 的 observed rolling
curl -X POST "$BASE/wx-observed-refresh-hotspots" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"
```

### 資料清理

```bash
# 清理 wx_cache 過期資料
curl -X POST "$BASE/wx-cleanup-expired-cache" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"

# 修剪 wx_hourly_series / wx_daily_series 的舊資料
curl -X POST "$BASE/wx-prune-time-series" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"

# 清理 wx_alerts 已過期事件（預設保留 30 天）
curl -X POST "$BASE/wx-alerts-prune" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "content-type: application/json" \
  -d '{ "keep_days": 30 }'
```

### 官方警報 ingest

```bash
# CAP/Atom feeds ingest（含 polygon/circle bbox 提取）
curl -X POST "$BASE/wx-alerts-ingest-cap" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"

# 香港天文台警報 ingest
curl -X POST "$BASE/wx-alerts-ingest-hko" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"

# 澳門氣象訊號 ingest（僅在有效訊號時插入）
curl -X POST "$BASE/wx-alerts-ingest-smg" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"

# 美國 NWS GeoJSON 警報 ingest（全美主動警報 + polygon bbox/centroid）
curl -X POST "$BASE/wx-alerts-ingest-nws" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"
```

### 專項資料刷新

```bash
# 空氣質素熱點刷新
curl -X POST "$BASE/wx-refresh-airquality-hotspots" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"

# 海洋資料熱點刷新（自動跳過陸地座標）
curl -X POST "$BASE/wx-refresh-marine-hotspots" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"

# METAR 觀測刷新（35 個全球優先站）
curl -X POST "$BASE/wx-observed-metar" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"

# 供應商健康度計算（近 15 分鐘失敗率 / P95 延遲）
curl -X POST "$BASE/wx-provider-health-refresh" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"
```

### Region Code 同步

```bash
curl -X POST "$BASE/wx-sync-region-codes" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "content-type: application/json" \
  -d '{ "hotspot_limit": 80, "hotspot_concurrency": 8 }'
```

**Request Body（可選）**

| 參數 | 說明 | 預設 |
|---|---|---|
| `hotspot_limit` | 本次最多處理幾個熱點 | 80 |
| `hotspot_concurrency` | 並行 reverse 請求數 | 8 |

**預期回應 200**

```json
{
  "synced_from_locations": 145,
  "hotspot_sync": {
    "upserted": 62,
    "failed": 1,
    "skipped": 17
  },
  "seeded": 312,
  "country_count": 42,
  "countries": ["HK", "MO", "US", "JP", "GB"],
  "synced_at": "2026-05-03T08:00:00.000Z"
}
```

---

## 一次性工具

### `POST /wx-hotspots-seed-global-cities` — 全球城市熱點種子

把「全球主要城市」寫入 `wx_hotspots`，讓熱點排程能立即運作。

**Request Body**

| 參數 | 說明 | 預設 |
|---|---|---|
| `limit` | 50–2000 | 300 |
| `geohash_precision` | 5–7 | 6 |

**範例**

```bash
curl -X POST "$BASE/wx-hotspots-seed-global-cities" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "content-type: application/json" \
  -d '{ "limit": 300, "geohash_precision": 6 }'
```

**預期回應 200**

```json
{
  "ok": true,
  "seeded": 298,
  "skipped": 2,
  "total": 300,
  "elapsed_ms": 1243
}
```

---

## API 21：系統健康狀態

### `GET /wx-status` — 系統健康摘要

回傳 DB 連線、供應商健康、Cron 工作排程與近期 ingest 健康度。

```bash
curl "$BASE/wx-status"
```

**預期回應 200（正常）/ 503（DB 異常）**

```json
{
  "version": "1.0.0",
  "ts": "2026-05-03T10:00:00.000Z",
  "db": { "ok": true, "error": null },
  "providers": [
    { "provider": "open_meteo",    "failure_rate_15m": 0.0,  "p95_latency_ms": 242, "circuit_open": false, "circuit_open_until": null, "updated_at": "2026-05-03T09:58:00.000Z" },
    { "provider": "met_norway",    "failure_rate_15m": 0.0,  "p95_latency_ms": 318, "circuit_open": false, "circuit_open_until": null, "updated_at": "2026-05-03T09:58:00.000Z" },
    { "provider": "pirate_weather","failure_rate_15m": 0.02, "p95_latency_ms": 490, "circuit_open": false, "circuit_open_until": null, "updated_at": "2026-05-03T09:58:00.000Z" },
    { "provider": "weatherapi",    "failure_rate_15m": 0.05, "p95_latency_ms": 510, "circuit_open": false, "circuit_open_until": null, "updated_at": "2026-05-03T09:58:00.000Z" }
  ],
  "cron_jobs": [
    { "jobname": "novaweather_refresh_hotspots_hourly", "schedule": "*/30 * * * *", "active": true, "next_run": "2026-05-03T10:30:00+00:00" },
    { "jobname": "novaweather_prune_ingest_runs",       "schedule": "23 3 * * *",   "active": true, "next_run": "2026-05-04T03:23:00+00:00" }
  ],
  "cron_health": [
    { "endpoint": "cron_refresh_hotspots_hourly", "last_ok": "2026-05-03T09:30:12.000Z", "last_error": null, "ok_1h": 2, "err_1h": 0, "stale": false, "max_age_sec": 2700 }
  ],
  "data_freshness": {
    "latest_hourly_valid_time": "2026-05-03T12:00:00.000Z",
    "latest_daily_fetched_at":  "2026-05-03T06:02:11.000Z",
    "latest_alert_created_at":  "2026-05-03T09:45:33.000Z"
  }
}
```

> `cron_health[].stale = true` 表示該工作的上次成功執行超過 `max_age_sec` 秒，需要排查。

---

## Cron 排程一覽

共 **20** 個 `pg_cron` 排程任務（v1.0.0 新增 Webhook fanout + worker）：

| 排程名稱 | 週期 | 說明 |
|---|---|---|
| `novaweather_refresh_hotspots_hourly` | `*/30 * * * *` | 熱點 hourly forecast 刷新 |
| `novaweather_refresh_hotspots_daily` | `0 */6 * * *` | 熱點 daily forecast 刷新 |
| `novaweather_observed_refresh_hotspots` | `*/15 * * * *` | 熱點 observed rolling 刷新 |
| `novaweather_cleanup_expired_cache` | `17 * * * *` | 清理過期 cache（每小時第 17 分）|
| `novaweather_prune_time_series` | `41 2 * * *` | 修剪舊時間序列（02:41 UTC）|
| `novaweather_alerts_prune` | `53 2 * * *` | 清理過期警報（02:53 UTC）|
| `novaweather_alerts_ingest_cap` | `*/10 * * * *` | CAP/Atom feeds ingest |
| `novaweather_alerts_ingest_hko` | `*/5 * * * *` | HKO 警報 ingest |
| `novaweather_alerts_ingest_smg` | `*/10 * * * *` | SMG 警報 ingest |
| `novaweather_alerts_ingest_nws` | `*/10 * * * *` | 美國 NWS GeoJSON 警報 ingest |
| `novaweather_provider_health_refresh` | `*/5 * * * *` | 供應商健康度計算 |
| `novaweather_refresh_airquality_hotspots` | `*/30 * * * *` | 熱點空氣質素刷新 |
| `novaweather_refresh_marine_hotspots` | `0 */6 * * *` | 熱點海洋資料刷新（自動跳過陸地）|
| `novaweather_observed_metar` | `*/10 * * * *` | METAR 觀測刷新（35 個全球優先站）|
| `novaweather_sync_region_codes` | `30 */2 * * *` | Region Code 同步（每 2 小時）|
| `novaweather_webhook_fanout` | `*/5 * * * *` | **v1.0.0** Webhook 事件掃描 → 寫入 queue |
| `novaweather_webhook_worker` | `* * * * *` | **v1.0.0** Webhook queue 認領 → HTTP POST（≤50/run）|
| `novaweather_prune_webhook_queue` | `37 3 * * *` | **v1.0.0** 清理 7 天前 webhook_queue 記錄（03:37 UTC）|
| `novaweather_prune_webhook_deliveries` | `15 3 * * *` | 清理 7 天前派送記錄（03:15 UTC）|
| `novaweather_prune_ingest_runs` | `23 3 * * *` | 清理 7 天前 ingest_runs（03:23 UTC）|

> 查詢即時狀態：`GET /wx-status` → `cron_jobs[]`（含 `next_run`）。

---

## 資料類型附錄

### WxHourlyPoint

```typescript
interface WxHourlyPoint {
  valid_time: string;           // ISO 8601 UTC

  temp_c: number | null;
  feels_like_c: number | null;  // 體感溫度（Met Norway compact 不提供，返回 null）
  humidity_pct: number | null;  // 0–100
  dewpoint_c: number | null;
  pressure_hpa: number | null;

  wind_ms: number | null;
  wind_dir_deg: number | null;  // 0–360
  gust_ms: number | null;

  precip_mm: number | null;
  precip_prob: number | null;   // 0–1
  snow_mm: number | null;

  cloud_pct: number | null;     // 0–100
  visibility_m: number | null;
  uv_index: number | null;

  provider: string;             // 供應商識別碼
  fetched_at: string;           // ISO 8601 UTC
  confidence: number | null;    // 0–1，模型可信度
}
```

### WxDailyPoint

```typescript
interface WxDailyPoint {
  date: string;                        // YYYY-MM-DD（UTC 日期，所有供應商均已正規化為 UTC 午夜）

  t_min_c: number | null;
  t_max_c: number | null;
  precip_sum_mm: number | null;
  precip_prob_max: number | null;      // 0–1
  wind_max_ms: number | null;
  uv_max: number | null;

  provider: string;                    // 供應商識別碼
  fetched_at: string;                  // ISO 8601 UTC
  confidence: number | null;           // 0–1，模型可信度
}
```

### WxAlert

```typescript
interface WxAlert {
  id: string;                    // UUID
  source: string;                // "HKO" | "NWS" | "SMG" | "CAP" | ...
  severity: "info" | "yellow" | "orange" | "red" | "emergency";
  title: string;
  description: string | null;
  starts_at: string | null;      // ISO 8601 UTC
  ends_at: string | null;        // ISO 8601 UTC
}
```

### WxNowcastPoint（v1.0.0）

15 分鐘粒度即時降雨 nowcasting（Open-Meteo `minutely_15`，不寫入長期 DB）：

```typescript
interface WxNowcastPoint {
  valid_time: string;        // ISO 8601 UTC
  precip_mm_h: number | null; // 降雨強度（mm/h，原始 15min 值 ×4 換算）
  precip_prob: number | null;  // 0–1
  wind_ms: number | null;
  gust_ms: number | null;
}
```

---

## 資料庫分區（v1.0.0）

`wx_ingest_runs` 與 `wx_hourly_series` 已轉換為 PostgreSQL **RANGE 月分區**（`pg_partman` 管理），自動建立未來 3 個月分區並保留 12 個月歷史。舊查詢不需修改——分區對 SQL 透明。
