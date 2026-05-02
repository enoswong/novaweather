## 版本狀態 v0.4.2
✅ 已完成 | ▢ 進行中 | ✖️ 已移除
- [✅] Supabase 全球天氣後端（/wx/*）[進度 100%] (v0.2.5)
- [✅] 詳細 API 實測頁（自動刷新）[進度 100%] (v0.2.6)
- [✅] 環境變化時間軸 API（分/時/日 + 未來數天）[進度 100%] (v0.3.0)
- [✅] API 實測頁連線修正與 API DOC 按鈕 [進度 100%] (v0.3.1)
- [✅] 跨網域代理（CORS Proxy）[進度 100%] (v0.3.2)
- [✅] Country/Region 主流程 API（country_code + region_code）[進度 100%] (v0.4.0)
- [✅] Region Code 排程同步重構（shared + cron）[進度 100%] (v0.4.1)
- [✅] Region Coverage 健康檢查與雲端排程 [進度 100%] (v0.4.2)

## 快速回顧（重要約束）
- **安全**：禁止在前端/公開環境使用 `SUPABASE_SERVICE_ROLE_KEY`；第三方 API keys 只能放在 Supabase Secrets/Vault。
- **契約先行**：對外主要提供 `/wx/*`（另有延伸 `wx-environment-timeline`）；供應商差異全部封裝在 adapters。
- **策略**：Open‑Meteo 主力 + WeatherAPI/Tomorrow/OpenWeather 備援；On-demand + 熱點預取。
- **資料層**：`wx_cache`（快取）+ `wx_hourly_series` / `wx_daily_series`（時間序列）+ `wx_alerts`（事件）+ `wx_risk_snapshots`（風險/變化）。

## 目錄結構（重點）
- `index.html`：詳細 API 實測頁（全端點測試、每個 API 獨立輸出、自動刷新）。
- `docs/api/wx.md`：API 契約。
- `docs/api/novaweather_api_doc.md`：整合版 API 文件（含 `wx-environment-timeline`）。
- `supabase/migrations/`：DB schema、RLS。
- `supabase/functions/`：Edge Functions。
- `.coding_progress`：進度快照。
- `devlog/error.log`：錯誤與解法。
- `CHANGELOG.md`：版本記錄。
