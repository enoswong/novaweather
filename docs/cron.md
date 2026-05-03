## 版本狀態 v1.0.0
✅ 已完成 | ▢ 進行中 | ✖️ 已移除
- [✅] Cron / Scheduler 設定 [進度 100%] (v0.2.5)
- [✅] Region Code 映射同步排程 [進度 100%] (v0.4.1)
- [✅] Region Code 雲端排程落地 [進度 100%] (v0.4.2)
- [✅] Region Sync 由 wx_hotspots 反查擴充 [進度 100%] (v0.4.3)
- [✅] Webhook 事件派送（異步解耦：fanout + worker 模式）[進度 100%] (v1.0.0)
- [✅] Webhook Queue 清理排程 [進度 100%] (v1.0.0)
- [✅] Ingest Runs 清理排程（分區後）[進度 100%] (v1.0.0)

## 目的
以 **熱點預取 + On-demand** 控制成本與延遲，並透過排程清理避免資料膨脹。

## 排程任務（Edge Functions）
- `wx-refresh-hotspots-hourly`：刷新熱點 72h hourly（每 30 分鐘）
- `wx-refresh-hotspots-daily`：刷新熱點 14d daily（每 6 小時）
- `wx-observed-refresh-hotspots`：刷新熱點 observed（每 15 分鐘）
- `wx-cleanup-expired-cache`：清理 `wx_cache` 過期資料（每小時）
- `wx-prune-time-series`：修剪 `wx_hourly_series` 舊資料（每日一次，分區後由 net.http_post 呼叫）
- `wx-alerts-ingest-cap`：官方 CAP/Atom feeds ingest（每 10 分鐘）
- `wx-alerts-ingest-hko`：港澳：香港天文台警報 ingest（每 5 分鐘）
- `wx-alerts-ingest-smg`：港澳：澳門氣象訊號 ingest（每 10 分鐘）
- `wx-alerts-ingest-nws`：美國 NWS GeoJSON 警報 ingest（每 10 分鐘）
- `wx-provider-health-refresh`：供應商健康度刷新（每 5 分鐘）
- `wx-alerts-prune`：清理已結束太久的警報（每日一次）
- `wx-sync-region-codes`：同步 `wx_region_codes`（每 30 分鐘；可選 JSON body：`hotspot_limit`、`hotspot_concurrency`）
- `wx-refresh-airquality-hotspots`：空氣質素熱點刷新（每 3 小時）
- `wx-observed-metar`：METAR 刷新（每 30 分鐘，15:00、45:00 交錯）
- `wx-refresh-marine-hotspots`：海洋資料熱點刷新（每 6 小時）
- `wx-webhook-fanout`：掃描新警報並寫入 `wx_webhook_queue`（每 5 分鐘，僅 DB 寫入）
- `wx-webhook-worker`：從 `wx_webhook_queue` 認領並批量發送（每 1 分鐘，≤50 筆/次，SKIP LOCKED）

## 雲端 novaweather 已建立的 Cron Jobs（共 20 個）
目前已透過 Supabase MCP 在 `novaweather` 建立以下 `pg_cron` jobs：

| 排程名稱 | Cron 表達式 | 觸發對象 | 說明 |
|---|---|---|---|
| `novaweather_refresh_hotspots_hourly` | `*/30 * * * *` | wx-refresh-hotspots-hourly | 熱點 hourly 預取 |
| `novaweather_refresh_hotspots_daily` | `0 */6 * * *` | wx-refresh-hotspots-daily | 熱點 daily 預取 |
| `novaweather_observed_refresh_hotspots` | `*/15 * * * *` | wx-observed-refresh-hotspots | 熱點 observed 更新 |
| `novaweather_alerts_ingest_cap` | `*/10 * * * *` | wx-alerts-ingest-cap | CAP Atom feeds |
| `novaweather_alerts_ingest_hko` | `*/5 * * * *` | wx-alerts-ingest-hko | 香港天文台警報 |
| `novaweather_alerts_ingest_smg` | `*/10 * * * *` | wx-alerts-ingest-smg | 澳門氣象訊號 |
| `novaweather_alerts_ingest_nws` | `*/10 * * * *` | wx-alerts-ingest-nws | NWS GeoJSON 警報 |
| `novaweather_provider_health_refresh` | `*/5 * * * *` | wx-provider-health-refresh | 供應商健康度 |
| `novaweather_cleanup_expired_cache` | `17 * * * *` | wx-cleanup-expired-cache | 清理過期快取 |
| `novaweather_prune_time_series` | `41 2 * * *` | wx-prune-time-series | 修剪舊時間序列 |
| `novaweather_alerts_prune` | `53 2 * * *` | wx-alerts-prune | 清理過期警報 |
| `novaweather_refresh_airquality_hotspots` | `5 */3 * * *` | wx-refresh-airquality-hotspots | AQ 熱點更新 |
| `novaweather_observed_metar` | `15,45 * * * *` | wx-observed-metar (POST) | METAR 刷新（35 站） |
| `novaweather_refresh_marine_hotspots` | `35 */6 * * *` | wx-refresh-marine-hotspots | 海洋熱點更新 |
| `novaweather_sync_region_codes` | `*/30 * * * *` | wx-sync-region-codes | Region code 同步 |
| `novaweather_webhook_fanout` | `*/5 * * * *` | wx-webhook-fanout | 警報→queue 寫入 |
| `novaweather_webhook_worker` | `* * * * *` | wx-webhook-worker | queue→HTTP 發送 |
| `novaweather_prune_webhook_queue` | `37 3 * * *` | _(純 SQL)_ | 清理 7 天前 done/failed queue 記錄 |
| `novaweather_prune_webhook_deliveries` | `15 3 * * *` | _(純 SQL)_ | 清理 7 天前 delivery 記錄 |
| `novaweather_prune_ingest_runs` | `23 3 * * *` | _(純 SQL)_ | 清理 7 天前 ingest_runs 記錄 |

> **注意**：`novaweather_webhook_dispatch` 已移除（v1.0.0），由 `novaweather_webhook_fanout` + `novaweather_webhook_worker` 取代。

### Webhook 異步解耦說明（v1.0.0）

```
[每 5 分鐘] novaweather_webhook_fanout
    → wx-webhook-fanout：掃描新警報，對每個訂閱寫 wx_webhook_queue（dedup_key 防重複）

[每 1 分鐘] novaweather_webhook_worker
    → wx-webhook-worker：呼叫 wx_claim_webhook_queue() RPC（SKIP LOCKED 原子認領）
    → 取出 ≤50 筆，並行 HTTP POST 到 callback_url（8s timeout）
    → 指數退避重試（最多 5 次）
    → 失敗 ≥ 10 次自動停用訂閱
```

## 如何建立排程
Supabase 的排程功能可在 Dashboard 的 Scheduler（或等效功能）設定：
1. 部署 functions（先）
2. 設定 secrets（第三方天氣 API keys）
3. 在 Scheduler 建立 HTTP 呼叫：
   - Method：`POST`
   - URL：`https://<project-ref>.supabase.co/functions/v1/<function-name>`
   - Header：`Authorization: Bearer <SERVICE_ROLE>`（僅 Scheduler/安全環境可用；不要暴露到前端）

## 熱點資料來源
`wx_hotspots` 可由以下來源逐步填入：
- 內建主要城市清單
- 用戶常用地點（聚合後）
- MVP 港澳固定熱點

## 一次性：快速塞入全球主要城市熱點
你可以手動呼叫一次 `wx-hotspots-seed-global-cities`，把「全球主要城市」寫入 `wx_hotspots`（預設 300 筆，可調整 50–2000）。
- Method：`POST`
- URL：`https://<project-ref>.supabase.co/functions/v1/wx-hotspots-seed-global-cities`
- Body（JSON）：`{ "limit": 300, "geohash_precision": 6 }`
