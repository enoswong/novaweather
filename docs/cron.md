## 版本狀態 v0.4.3
✅ 已完成 | ▢ 進行中 | ✖️ 已移除
- [✅] Cron / Scheduler 設定 [進度 100%] (v0.2.5)
- [✅] Region Code 映射同步排程 [進度 100%] (v0.4.1)
- [✅] Region Code 雲端排程落地 [進度 100%] (v0.4.2)
- [✅] Region Sync 由 wx_hotspots 反查擴充 [進度 100%] (v0.4.3)

## 目的
以 **熱點預取 + On-demand** 控制成本與延遲，並透過排程清理避免資料膨脹。

## 排程任務（Edge Functions）
- `wx-refresh-hotspots-hourly`：刷新熱點 72h hourly（建議每 30–60 分鐘）
- `wx-refresh-hotspots-daily`：刷新熱點 14d daily（建議每 6–12 小時）
- `wx-observed-refresh-hotspots`：刷新熱點 observed（建議每 10–30 分鐘）
- `wx-cleanup-expired-cache`：清理 `wx_cache` 過期資料（建議每 1–6 小時）
- `wx-prune-time-series`：修剪時間序列舊資料（建議每日一次）
- `wx-alerts-ingest-cap`：官方 CAP/Atom feeds ingest（建議每 5–15 分鐘）
- `wx-alerts-ingest-hko`：港澳：香港天文台警報 ingest（建議每 1–5 分鐘）
- `wx-alerts-ingest-smg`：港澳：澳門氣象訊號 ingest（建議每 5–15 分鐘）
- `wx-provider-health-refresh`：供應商健康度刷新（建議每 1–5 分鐘）
- `wx-alerts-prune`：清理已結束太久的警報（建議每日一次）
- `wx-sync-region-codes`：同步 `wx_region_codes`（來源：`wx_locations` → `wx_hotspots`＋Open‑Meteo Reverse → 種子映射；建議每 30–60 分鐘；可選 JSON body：`hotspot_limit`、`hotspot_concurrency`）

## 雲端 novaweather 已建立的 Cron Jobs
目前已透過 Supabase MCP 在 `novaweather` 建立以下 `pg_cron` jobs：
- `novaweather_refresh_hotspots_hourly`：每 30 分鐘
- `novaweather_refresh_hotspots_daily`：每 6 小時
- `novaweather_observed_refresh_hotspots`：每 15 分鐘
- `novaweather_alerts_ingest_cap`：每 10 分鐘
- `novaweather_alerts_ingest_hko`：每 5 分鐘
- `novaweather_alerts_ingest_smg`：每 10 分鐘
- `novaweather_provider_health_refresh`：每 5 分鐘
- `novaweather_cleanup_expired_cache`：每小時
- `novaweather_prune_time_series`：每日
- `novaweather_alerts_prune`：每日
- `novaweather_sync_region_codes`：每 30 分鐘

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
