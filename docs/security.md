## 版本狀態 v0.3.0
✅ 已完成 | ▢ 進行中 | ✖️ 已移除
- [✅] Security / RLS / Secrets [進度 100%] (v0.2.1)

## 核心原則
- **禁止外流 `service_role`**：任何前端/客戶端都只能使用 `anon` key。
- **第三方 API keys**（WeatherAPI/OpenWeather/Tomorrow）只能放在 **Supabase Secrets/Vault**，由 Edge Functions 讀取。
- **公共讀、受控寫**：天氣資料可公開讀；寫入只允許 Edge Functions 使用 `service_role`（繞過 RLS）。

## RLS 策略（目前）
- `wx_*` 表已啟用 RLS
- `SELECT`：允許 `anon`、`authenticated`
- `INSERT/UPDATE/DELETE`：不提供 public policy（必須由 Edge Functions/service role 寫入）

## Secrets / Vault 建議
- 在 Supabase Dashboard 設定以下 Secrets：
  - `WEATHER_API_KEY`
  - `OPENWEATHER_API_KEY`
  - `TOMORROW_IO_API_KEY`

## Scheduler / Cron 安全
- Scheduler 呼叫 functions 時需要授權。
- **建議**：Scheduler 在安全環境使用 `service_role`（或等效機制）呼叫 `POST /functions/v1/<job>`；不要把該 token 暴露到任何前端。

## 已知風險（目前）
- 供應商備援是「優先序 + 失敗回退」，目前尚未做自動 circuit-break（可用 `wx_provider_health` 擴充）。
- 若你打算把 `/wx/*` 完全對公網開放，請額外加上：
  - WAF / rate limit（或在 Edge Function 內做 per-IP 限流）
  - 成本保護（例如只允許合理的 `hours/days` 上限，這部分程式已做 clamp）
