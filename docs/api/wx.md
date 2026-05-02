## 版本狀態 v0.4.2
✅ 已完成 | ▢ 進行中 | ✖️ 已移除
- [✅] /wx/* API Contract [進度 100%] (v0.2.0)
- [✅] Environment Timeline API（延伸）[進度 100%] (v0.3.0)
- [✅] Region Code 同步與 Country/Region 主流程 [進度 100%] (v0.4.1)
- [✅] Region Coverage Health API [進度 100%] (v0.4.2)

## 概述
`/wx/*` 是「全球天氣 / 溫度 / 環境變化」後端對外主要契約。

設計原則：
- **SI 單位**：所有數值以 SI 單位回傳。
- **缺值策略**：供應商沒有的欄位回傳 `null`，不得改欄位名稱或結構。
- **一致時間**：所有時間欄位為 ISO 8601（UTC），另提供 `timezone` 供前端顯示。
- **可追溯性**：回應包含 `provider` 與 `fetched_at`，支援觀測與除錯。

## 通用 Query 參數
- `lat`：緯度（-90 ~ 90）
- `lon`：經度（-180 ~ 180）
- `place_id`：精準位置識別（可選；建議搭配 `wx-geo-forward`）
- `provider`：`auto | open_meteo | weatherapi | tomorrow_io | openweather`
- `allow_live_fetch`：`true | false`（預設 `true`）

## 通用回應 meta（摘要）
- `fetched_at`：ISO 8601 UTC
- `timezone`：IANA timezone（例如 `Asia/Hong_Kong`）
- `lat` / `lon` / `geohash`
- `place_id` / `country_code` / `admin1` / `admin2` / `admin3` / `admin4` / `locality` / `name`（若可得）
- `provider`（若端點涉及供應商）

## Endpoints（對外契約）
- `GET /wx-country-today`
- `GET /wx-region`
- `GET /wx-region-coverage`
- `GET /wx-geo-forward`
- `GET /wx-geo-reverse`
- `GET /wx-forecast-hourly`
- `GET /wx-forecast-daily`
- `GET /wx-observed-now`
- `GET /wx-alerts`
- `GET /wx-risk`

> 完整 Query/Response 定義請以 `docs/api/novaweather_api_doc.md` 為準。

## 延伸端點（環境變化時間軸）
- `GET /wx-environment-timeline`：minute/hourly/daily + 未來數天與極端天氣風險（詳見 `docs/api/novaweather_api_doc.md`）

## 內部識別說明
- `place_id` 為內部穩定鍵，主要由 geo ingestion 建立。
- 對外主流程建議使用 `country_code + region_code`，由後端映射至內部位置資料。

