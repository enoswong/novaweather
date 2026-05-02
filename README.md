## 版本狀態 v0.9.0
✅ 已完成 | ▢ 進行中 | ✖️ 已移除
- [✅] 全球天氣後端（Supabase）[進度 100%] (v0.2.5)
- [✅] 詳細 API 實測頁（自動刷新）[進度 100%] (v0.2.6)
- [✅] 環境變化時間軸 API（分/時/日 + 未來數天）[進度 100%] (v0.3.0)
- [✅] API 實測頁連線修正與 API DOC 按鈕 [進度 100%] (v0.3.1)
- [✅] 跨網域代理（CORS Proxy）[進度 100%] (v0.3.2)
- [✅] Country/Region 主流程 API（country_code + region_code）[進度 100%] (v0.4.0)
- [✅] Region Code 排程同步重構（shared + cron）[進度 100%] (v0.4.1)
- [✅] Region Coverage 健康檢查與雲端排程 [進度 100%] (v0.4.2)
- [✅] Phase A 重大修正：Geo-Reverse、Region-Codes、SMG 警報地理、CAP bbox [進度 100%] (v0.5.0)
- [✅] 空氣質素 API（Open-Meteo AQ）+ METAR 觀測站（35 全球站）[進度 100%] (v0.5.0)
- [✅] NWS GeoJSON 警報（美國全域，含多邊形幾何）[進度 100%] (v0.5.0)
- [✅] 服務健康頁 GET /wx-status [進度 100%] (v0.5.0)
- [✅] 海洋 API（Open-Meteo Marine：波浪/海流/海溫）[進度 100%] (v0.6.0)
- [✅] 太陽輻射 API（Open-Meteo Solar：短波/直射/散射/DNI/GHI）[進度 100%] (v0.6.0)
- [✅] 歷史天氣 API（Open-Meteo Archive，1940 至今）[進度 100%] (v0.6.0)
- [✅] 天文曆 API（日出/日落/晨昏/月相，純計算）[進度 100%] (v0.6.0)
- [✅] 聚合 Bundle API（單請求並行多資料集）[進度 100%] (v0.7.0)
- [✅] 供應商 fetch 超時修正（10s AbortSignal，修復 HK 冷啟動卡死）[進度 100%] (v0.7.0)
- [✅] 複合指數 API（舒適度/健康/戶外/能源）[進度 100%] (v0.8.0)
- [✅] 多地比較 API（最多 5 點並行，含 delta 分析）[進度 100%] (v0.8.0)
- [✅] 氣候異常偵測 API（30 年歷史常態 + Z-score）[進度 100%] (v0.8.0)
- [✅] Webhook 推送 API（訂閱警報事件，HMAC-SHA256 簽名，5 分鐘派送，自動停用）[進度 100%] (v0.9.0)
- [✅] API 實測頁全面更新（35 端點、分組、lat/lon + 專用欄位）[進度 100%] (v0.9.0)

## 專案概述
本專案建立一個可擴展的 **Supabase 全球天氣後端**，提供統一的 `/wx/*` API：快取 + 歷史時間序列 + 多供應商備援 +（可選）地區官方警報插件 + 風險/環境變化輸出。

## 目前功能狀態
- **API Contract（/wx/*）**：✅
- **資料庫 Schema（wx_*）**：✅
- **Edge Functions（providers + aggregation）**：✅
- **Cron（熱點預取 + 清理）**：✅
- **Risk/Alerts（rule baseline + 港澳插件）**：✅
- **安全/RLS/Secrets**：✅

## 開發與部署（Supabase）
> 注意：請勿在任何地方（程式碼、前端、公開文件）使用 `service_role` key。第三方天氣 API keys 必須放在 Supabase Secrets/Vault。

### 先決條件
- 已安裝 Supabase CLI
- 你有一個 Supabase 專案（可使用雲端或本地 `supabase start`）

### 本地啟動（範例）
1. 初始化（若尚未做）

```bash
supabase init
```

2. 本地啟動

```bash
supabase start
```

3. 套用 migrations

```bash
supabase db reset
```

4. 部署 Edge Functions（依實際建立的 functions）

```bash
supabase functions deploy wx-forecast-hourly
```

## 文件
- `docs/api/wx.md`：/wx/* API 契約與欄位定義（SI 單位、缺值策略）
- `index.html`：詳細 API 實測頁（可測 GET/POST 端點、每個 API 各自輸出 JSON、顯示延遲/回應大小/下次刷新時間）
- `docs/api/novaweather_api_doc.md`：新增 `GET /wx-environment-timeline`（minute/hourly/daily + extreme weather risk）
- `supabase/migrations/`：資料表 schema 與 RLS
- `supabase/functions/`：Edge Functions（providers + aggregation）
- `docs/cron.md`：排程任務說明
- `docs/security.md`：Secrets/RLS 安全規範

