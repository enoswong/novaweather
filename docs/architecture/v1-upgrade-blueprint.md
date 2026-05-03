# NovaWeather v1.0.0 架構升級與優化藍圖（修訂版）

> **修訂說明**：本文件依據實際 codebase（supabase/functions、migrations、_shared 模組）
> 審查原始藍圖後修正，標示 ⚠️ 的段落為原文錯誤或遺漏之處。

---

## 現況快照（基線）

| 指標 | 現況 |
|---|---|
| Edge Functions | 41 個（含 wx-api-proxy 統一入口） |
| 資料表 | 17 張（含 PostGIS、pg_cron） |
| pg_cron 排程 | 17 個 |
| 外部 API 來源 | 11 個（4 供應商 + 2 地理 + 4 官方警報 + NOAA） |
| 已建索引國家/地區 | 40 國、93 地區（38 國有即時資料） |
| 快取鍵格式 | `{geohash6}\|{endpoint}\|{param=val}...`（geohash ≈ 1.2km 格網） |
| Webhook | HMAC-SHA256 簽名，每 5 分鐘 pg_cron 派送 |

---

## 階段一：API 介面標準化與安全防護（Quick Wins）

*目標：消除文件與實作的歧義，建立可防禦的開發者入口。*

---

### 1.1 路由實際現況與修正方向

#### 現況釐清

⚠️ **原文說「全面採用扁平化路由」有誤**：系統已全面使用扁平命名（`wx-geo-forward`、`wx-forecast-hourly`）。
真正的不一致在於：

| 問題點 | 現況 | 應修正為 |
|---|---|---|
| API Doc 顯示路徑 | `/wx/geo/forward` | 改為 `GET /wx-geo-forward`（與 Edge Function 名一致） |
| Proxy 呼叫方式 | `?fn=wx-geo-forward`（Query String 路由） | 維持，但文件需明確說明 |
| wx-api-proxy 的 DELETE 允許範圍 | 所有白名單 Function 均可 DELETE | 應限縮：僅 `wx-webhook-register` 允許 DELETE；其餘只開 GET/POST |

#### Webhook 語義修正

⚠️ **原文同時列出兩個方案（DELETE + POST），且 POST 刪除違反 REST**。

**確定方案**：維持 `DELETE /wx-webhook-register`，補上 `id` 路徑語義說明即可，無需改名。
`owner_key` 作為身份驗證參數透過 Query String 傳遞，合理且對稱。

```
POST   /wx-webhook-register          ← 建立訂閱
GET    /wx-webhook-register?owner_key=xxx  ← 列出訂閱
DELETE /wx-webhook-register?id=xxx&owner_key=xxx  ← 停用訂閱（軟刪除）
```

若未來升級為 RESTful resource endpoint，正確做法是：
```
POST   /wx-webhook-subscriptions
GET    /wx-webhook-subscriptions?owner_key=xxx
DELETE /wx-webhook-subscriptions/{id}?owner_key=xxx
```

---

### 1.2 時區定義明確化（修正實作 Bug）

⚠️ **原文只提到「在文件中宣告」，但根本問題在 Schema 層**。

#### 問題根源

`wx_daily_series.date` 欄位型別為 `DATE`（無時區），Open-Meteo 回傳的日期基於**當地時區（`meta.timezone`）**。
對香港（UTC+8）用戶，「2026-05-03 本地日」從 UTC `2026-05-02T16:00:00Z` 開始，
但若 Edge Function 在 UTC 零時後呼叫，寫入的 `date = '2026-05-03'` 實際代表的本地時間範圍有歧義。

#### 修正方案

**短期（文件層）**：在 API Doc 所有 daily 回應範例加上說明：
```
"meta.timezone": "Asia/Hong_Kong",
// 所有 daily.date 均基於 meta.timezone（當地日期），非 UTC
```

**中期（Schema 層）**：`wx_daily_series` 加入 `timezone TEXT NOT NULL DEFAULT 'UTC'` 欄位，
讓後續查詢可過濾正確的本地日期。

```sql
ALTER TABLE wx_daily_series ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';
-- 建議索引
CREATE INDEX IF NOT EXISTS wx_daily_series_geohash_date_tz_idx
  ON wx_daily_series (geohash, date DESC, timezone);
```

---

### 1.3 公開 GET 端點防護（修正安全方案）

⚠️ **原文建議「嚴格校驗 Origin/Referer」是錯誤的安全做法**：
這兩個 Header 在任何 HTTP 客戶端（curl、Postman）均可任意偽造，對後端無保護作用。

#### 正確的防護策略

**優先度從高到低：**

| 層級 | 方案 | 實作位置 | 說明 |
|---|---|---|---|
| 1（最有效） | Supabase API Gateway Rate Limiting | Supabase Dashboard | 依 IP 限制，不需改 code |
| 2 | 輕量 API Key（Header：`X-WxApi-Key`） | `wx-api-proxy/index.ts` | 只需比對 Supabase Secret，低成本 |
| 3 | 用量監控 + 自動封鎖 | `wx_ingest_runs` + PostHog | 異常流量告警，人工或自動封禁 |

**API Key 最小實作（wx-api-proxy 加 10 行）：**

```typescript
// wx-api-proxy/index.ts
const API_KEY = Deno.env.get("WX_PUBLIC_API_KEY"); // Supabase Secret
const clientKey = req.headers.get("x-wxapi-key");
if (API_KEY && clientKey !== API_KEY) {
  return json({ error: "Unauthorized" }, 401);
}
```

> 若不加 API Key，至少在 Supabase Dashboard 啟用「IP Rate Limiting」：
> Settings → API → Rate Limits → 設定 100 req/min per IP。

---

## 階段二：資料庫效能與高併發改造（Core Stability）

*目標：解決長期資料膨脹、慢查詢與排程可靠性問題。*

---

### 2.1 分區表（Table Partitioning）——修正目標選擇

⚠️ **原文將 `wx_cache` 列為分區對象，但 `wx_cache` 的主鍵是 `TEXT`（`cache_key`），
無法直接對文字主鍵套用 `PARTITION BY RANGE`，需要大幅改變 Schema。**

⚠️ **原文遺漏了最重要的目標：`wx_ingest_runs`**——每次 API 呼叫都寫入一列，
無分區的情況下這是膨脹最快的表。

#### 修正後的分區優先序

| 優先度 | 資料表 | 分區鍵 | 建議分區粒度 | 原因 |
|---|---|---|---|---|
| 🔴 最優先 | `wx_ingest_runs` | `started_at` | 月 | 每次 API 呼叫都寫入，成長最快 |
| 🔴 最優先 | `wx_hourly_series` | `valid_time` | 月 | 核心序列，資料最多 |
| 🟡 次優先 | `wx_air_quality_series` | `valid_time` | 月 | 結構與 hourly_series 相同 |
| 🟡 次優先 | `wx_marine_series` | `valid_time` | 月 | 同上 |
| 🟡 次優先 | `wx_webhook_deliveries` | `attempted_at` | 週 | 目前有 7 天刪除 cron，分區後 DROP 更快 |
| 🟢 暫緩 | `wx_cache` | _(主鍵衝突，需改 Schema)_ | — | 現有 TTL + cleanup cron 已足夠 |

**`wx_hourly_series` 月分區範例（Migration）：**

```sql
-- Step 1: 建立新分區父表
CREATE TABLE wx_hourly_series_p (
  LIKE wx_hourly_series INCLUDING ALL
) PARTITION BY RANGE (valid_time);

-- Step 2: 建立月分區
CREATE TABLE wx_hourly_series_2026_04
  PARTITION OF wx_hourly_series_p
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

CREATE TABLE wx_hourly_series_2026_05
  PARTITION OF wx_hourly_series_p
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

-- Step 3: 遷移現有資料後切換表名
-- Step 4: 清理舊分區只需 DROP TABLE（無 Vacuum 負擔）
```

---

### 2.2 游標分頁（Cursor-based Pagination）

**評估**：目前 `/wx-country-today` 最多 93 個地區，OFFSET 分頁效能影響可忽略。
**建議**：當地區數突破 500 時再實作，過早優化增加複雜度。

若未來需要，正確做法：

```
GET /wx-country-today?country_code=US&limit=50&cursor=eyJpZCI6MjB9
Response: { "next_cursor": "eyJpZCI6NzB9", "regions": [...] }
```

---

### 2.3 快取命中率（修正錯誤方案）

⚠️ **原文建議「將經緯度四捨五入至小數點後二位」，但系統已用 Geohash 精度 6（≈1.2km）作為快取鍵，
這正是格網化快取的實作。「四捨五入至小數後二位」反而退步：`22.31` 與 `22.314` 在相同 Geohash 格內，
但 `22.31` 與 `22.32` 可能跨越不同 Geohash，造成命中率不穩定。**

**真正可優化的快取命中率問題：**

1. **`hours` 參數導致快取碎片化**：用戶帶 `hours=72` 和 `hours=48` 會產生不同 cache_key。
   解法：將 `hours` 向上取整到固定值（24/48/72/120/168），減少快取鍵種類。

2. **`provider` 參數碎片化**：`provider=auto` 和 `provider=open_meteo` 視為不同鍵，但結果可能相同。
   解法：在寫入快取前將成功使用的 provider 記錄在 payload meta，cache_key 統一用 `provider=auto`。

**修正實作（`storage.ts`）：**

```typescript
// 量化 hours 至固定級別，減少快取碎片
function normalizeHours(hours: number): number {
  const levels = [24, 48, 72, 120, 168];
  return levels.find(l => l >= hours) ?? 168;
}

// 快取鍵不包含具體 provider，統一為 auto
export function buildCacheKey(args: {
  geohash: string;
  endpoint: string;
  params: Record<string, unknown>;
}): string {
  const normalized = { ...args.params };
  if ('hours' in normalized) normalized.hours = normalizeHours(Number(normalized.hours));
  if ('provider' in normalized) delete normalized.provider; // provider 不進 key
  // ... 其餘邏輯不變
}
```

---

### 2.4 pg_cron 可靠性（原文遺漏）

⚠️ **原文未提到 pg_cron + pg_net 完全沒有重試機制**：若 Edge Function 冷啟動超時或臨時報錯，
該批次任務直接靜默失敗，沒有告警。

**短期修正（監控層）**：

```sql
-- 查詢過去 1 小時內失敗的排程
SELECT jobname, run_started_at, status, return_message
FROM cron.job_run_details
WHERE run_started_at > now() - INTERVAL '1 hour'
  AND status != 'succeeded'
ORDER BY run_started_at DESC;
```

在 `wx-status` 端點加入 cron 健康度：

```typescript
// 新增到 GET /wx-status 回應
"cron_health": {
  "failed_last_hour": 2,
  "jobs_checked": 17,
  "last_failure": { "jobname": "novaweather_alerts_ingest_hko", "at": "..." }
}
```

**中期修正（自修復）**：在每個 Ingest Function 內部加入 `retry_count` 邏輯，
失敗時等待 2s 後自動重試一次（已在 AbortSignal 10s timeout 內）。

---

### 2.5 Webhook 派送異步解耦

**問題正確**：當訂閱數增長，`wx-webhook-dispatch` 以 `Promise.allSettled` 並行發送，
一旦超過 Edge Function 30s 限制，尾部訂閱會靜默丟失。

**Supabase 原生 Queue 方案（不需 Redis/外部服務）**：

```
┌─────────────────────────────┐
│  wx_webhook_queue（新表）     │
│  id, subscription_id        │
│  payload, status            │
│  scheduled_at, claimed_at   │
└────────────┬────────────────┘
             │
pg_cron 每 5 分鐘
    → wx-webhook-fanout（只寫 queue，不 HTTP POST）
             │
pg_cron 每 1 分鐘
    → wx-webhook-worker（取出 50 筆，並行發送）
```

```sql
CREATE TABLE wx_webhook_queue (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES wx_webhook_subscriptions(id),
  payload        JSONB NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'sending', 'done', 'failed')),
  scheduled_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at     TIMESTAMPTZ,
  done_at        TIMESTAMPTZ,
  attempts       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ON wx_webhook_queue (status, scheduled_at) WHERE status = 'pending';
```

---

## 階段三：多源並行與動態路由策略（Ensemble & Smart Routing）

*目標：最大化免費額度，建立智能分流，提供高精度聚合預報。*

---

### 3.1 擴充供應商池（修正選擇）

⚠️ **Visual Crossing 免費額度 1000 次/天（≈ 41 次/小時），對全球多熱點平台毫無實用性，應移除。**

**修正後的供應商池：**

| 供應商 | 免費額度 | 優勢 | 地理強項 |
|---|---|---|---|
| **Open-Meteo** | 無限（非商業） | 主力，無需 Key，ICON+GFS 混合 | 全球 |
| **Met Norway / Yr.no** | 無限（Attribution needed） | ECMWF 模型，歐洲精度最高 | 全球，歐洲最佳 |
| **Pirate Weather** | 20,000 次/月 | Dark Sky 算法，北美降雨精準 | 北美 |
| **WeatherAPI.com** | 依方案 | 備援，支援歷史 | 全球 |
| **Tomorrow.io** | 依方案 | 備援，分鐘級資料 | 全球 |
| **OpenWeatherMap** | 1,000 次/天（免費） | 最後備援 | 全球 |

> Met Norway API 端點：`https://api.met.no/weatherapi/locationforecast/2.0/compact`，
> 需在 `User-Agent` 附上聯絡資訊（attribution 要求）。

---

### 3.2 額度感知路由器（Quota-Aware Router）

利用現有 `wx_provider_health.failure_rate_15m` 作為動態權重：

```typescript
// provider_chain.ts 新增
function selectProvider(region?: string): WxProvider {
  // 1. 地理路由：優先選擇對該地區最準的供應商
  if (region === 'EU') return 'met_norway';
  if (region === 'NA') return 'pirate_weather';

  // 2. 健康度路由：跳過近期失敗率 > 30% 的供應商
  const unhealthy = getUnhealthyProviders(); // 查 wx_provider_health
  const priority = ['open_meteo', 'met_norway', 'weatherapi', 'tomorrow_io', 'openweather']
    .filter(p => !unhealthy.has(p));

  return (priority[0] as WxProvider) ?? 'open_meteo';
}
```

---

### 3.3 地理智能路由（Geo-Routing）

依 `wx/geo/reverse` 結果的 `country_code` 路由，**基於資料品質而非國籍**：

| 地區 | 優先供應商 | 理由 |
|---|---|---|
| 歐洲（country_code: EU 國家） | Met Norway | ECMWF 模型，歐洲精度最高 |
| 北美（US, CA） | Pirate Weather → Open-Meteo | Dark Sky 降雨演算法，北美更準 |
| 東亞（CN, JP, KR, TW, HK） | Open-Meteo | 覆蓋完整，免費 |
| 其他 | Open-Meteo → 備援鏈 | 預設主力 |

---

### 3.4 熱點多模型聚合（Hotspot Ensemble Forecasting）

在 `wx-refresh-hotspots-hourly` 中，對核心 50 個熱點並行呼叫 2~3 個供應商，
以 **provider confidence 加權平均** 寫入 `wx_hourly_series`：

```typescript
// 加權平均（以 confidence 欄位為權重）
const providers = ['open_meteo', 'met_norway'];
const results = await Promise.allSettled(
  providers.map(p => fetchForecastWithProvider({ provider: p, lat, lon, hours, days }))
);

// 只對成功結果加權平均
const weights = { open_meteo: 0.55, met_norway: 0.45 };
const ensemble = mergeWeighted(results, weights);

// 寫入時標記 provider='nova_ensemble'
await upsertHourlySeries(supabase, {
  geohash, kind: 'forecast', provider: 'nova_ensemble', points: ensemble
});
```

**注意**：Ensemble 只寫入熱點（高流量地點），一般 live fetch 仍走單一供應商。

---

## 階段四：分鐘級臨近預報（Nowcasting）

*目標：提供「未來 60 分鐘降雨」殺手級功能，不讓分鐘資料污染長期資料庫。*

---

### 4.1 資料庫隔離原則（確認正確）

`wx_hourly_series` 維持 1 小時粒度，分鐘級資料**絕不**寫入長期資料庫。

---

### 4.2 短效穿透策略（修正技術細節）

⚠️ **原文「Open-Meteo Minutely」錯誤**：Open-Meteo 的最小時間粒度為 **`minutely_15`（15 分鐘間隔）**，
非 per-minute 資料，且需要加 `forecast_minutely_15` 參數。

⚠️ **原文提到 Redis**：系統目前無 Redis，正確方案是使用 `wx_cache` + 短 TTL。

**修正後的 Nowcasting 流程：**

```
GET /wx-environment-timeline?lat=22.3&lon=114.2&minute_window=60
    │
    ▼
[1] 查 wx_cache（cache_key 含 endpoint=minutely_15, TTL=5分鐘）
    │
    ├── [命中] → 直接回傳
    │
    └── [miss] → 並行 Live Fetch：
                   ├── Open-Meteo minutely_15（免費，全球，15 分鐘粒度）
                   └── Tomorrow.io minutely（付費，1 分鐘粒度，用量謹慎）
                 → 合併結果 → 寫 wx_cache（TTL: 5 分鐘）→ 回傳
```

**Open-Meteo minutely_15 呼叫範例：**

```typescript
const url = new URL("https://api.open-meteo.com/v1/forecast");
url.searchParams.set("latitude", String(lat));
url.searchParams.set("longitude", String(lon));
url.searchParams.set("minutely_15", [
  "precipitation",
  "precipitation_probability",
  "wind_speed_10m",
  "wind_gusts_10m"
].join(","));
url.searchParams.set("forecast_minutely_15", "8"); // 未來 2 小時（8 × 15min）
url.searchParams.set("timezone", "auto");
```

---

### 4.3 Nowcasting Payload 精簡

分鐘/15 分鐘資料結構僅保留決策關鍵欄位：

```typescript
interface NowcastPoint {
  valid_time: string;      // ISO 8601
  precip_mm_h: number | null;     // 降雨強度（mm/小時換算）
  precip_prob: number | null;     // 0–100
  gust_ms: number | null;         // 陣風
  wind_ms: number | null;         // 平均風速
}
// 省略：temp_c、humidity_pct、pressure_hpa、dewpoint_c 等
// 理由：15 分鐘內這些值變化極微，對使用者決策無意義
```

---

## 附錄：遺漏項目清單（原文未涵蓋）

| 項目 | 說明 | 建議時間點 |
|---|---|---|
| **MO/AE 資料空缺** | 澳門/杜拜地區已建索引但無快取資料，首次查詢依賴 live fetch | v0.9.1 補種子資料 |
| **`wx_ingest_runs` 無上限成長** | 每次 API 呼叫寫一列，無 cron 清理 | 立即加清理排程（保留 7 天） |
| **pg_cron 無重試機制** | Edge Function 失敗後靜默放棄 | 加 `cron_health` 到 `/wx-status` |
| **METAR 站點擴充** | 目前 35 站，非洲/中亞覆蓋稀少 | v1.0 前補充至 60 站 |
| **`wx-api-proxy` DELETE 過度開放** | 目前所有白名單 Function 均可 DELETE | 限縮只允許 `wx-webhook-register` |
| **Daily 預報時區文件** | `wx_daily_series.date` 基於 provider 本地時，文件未說明 | 立即更新文件 + 加 timezone 欄位 |

---

## 版本路線圖

```
v0.9.1（立即）
  ├── 加 wx_ingest_runs 清理排程（保留 7 天）
  ├── wx-api-proxy DELETE 限縮
  ├── 修正 API Doc 路由描述（/wx/geo/forward → /wx-geo-forward）
  ├── 補 MO/AE 觀測資料（手動觸發 live fetch 預熱）
  └── wx-status 加入 cron 健康度

v1.0.0-alpha（階段一 + 階段二）
  ├── wx_ingest_runs 月分區
  ├── wx_hourly_series 月分區
  ├── 快取鍵 hours 量化
  ├── wx-api-proxy 加 API Key 驗證
  └── wx_daily_series 加 timezone 欄位

v1.0.0-beta（階段三）
  ├── Met Norway adapter
  ├── Pirate Weather adapter
  ├── Geo-Routing 邏輯
  └── Ensemble Forecasting（核心 50 熱點）

v1.0.0（階段四）
  ├── minutely_15 Nowcasting（Open-Meteo）
  ├── wx_webhook_queue 異步解耦
  └── Webhook Worker cron
```
