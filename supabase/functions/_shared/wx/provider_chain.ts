// 修改說明：供應商優先序 + 熔斷檢查 + 統一抓取介面
// 影響文件：supabase/functions/_shared/wx/provider_chain.ts
// v1.0.0-beta: 加入 Met Norway、Pirate Weather 以及地理感知路由（Geo-Routing）

import type { WxProvider } from "./types.ts";
import { fetchOpenMeteoForecast } from "./providers/open_meteo.ts";
import { fetchWeatherApiForecast } from "./providers/weatherapi.ts";
import { fetchTomorrowIoForecast } from "./providers/tomorrow_io.ts";
import { fetchOpenWeatherForecast } from "./providers/openweather.ts";
import { fetchMetNorwayForecast } from "./providers/met_norway.ts";
import { fetchPirateWeatherForecast } from "./providers/pirate_weather.ts";

// ── 地理路由常數 ────────────────────────────────────────────────────────────
// 歐洲國家（Met Norway ECMWF 模型精度最高）
// 含 EU、EEA、英國、巴爾幹等地區
const EU_COUNTRY_CODES = new Set([
  "AD", "AL", "AT", "BA", "BE", "BG", "BY", "CH", "CY", "CZ", "DE", "DK",
  "EE", "ES", "FI", "FR", "GB", "GR", "HR", "HU", "IE", "IS", "IT", "LI",
  "LT", "LU", "LV", "MC", "MD", "ME", "MK", "MT", "NL", "NO", "PL", "PT",
  "RO", "RS", "SE", "SI", "SK", "SM", "TR", "UA", "VA", "XK",
]);

// 北美（Pirate Weather Dark Sky 算法降雨最準）
const NA_COUNTRY_CODES = new Set(["US", "CA"]);

// ── 供應商優先序 ────────────────────────────────────────────────────────────

/** 全球預設優先序（Open-Meteo 主力，其餘備援） */
export function defaultProviderPriority(): Exclude<WxProvider, "auto" | "nova_ensemble">[] {
  return ["open_meteo", "weatherapi", "tomorrow_io", "openweather"];
}

/**
 * 依地理位置（country_code）選擇最優供應商鏈。
 * 基於資料品質而非國籍路由：歐洲優先 Met Norway (ECMWF)，北美優先 Pirate Weather。
 */
export function geoRoutedPriority(
  country_code?: string | null,
): Exclude<WxProvider, "auto" | "nova_ensemble">[] {
  if (country_code && EU_COUNTRY_CODES.has(country_code)) {
    // Met Norway → Open-Meteo → WeatherAPI → Tomorrow.io → OpenWeather
    return ["met_norway", "open_meteo", "weatherapi", "tomorrow_io", "openweather"];
  }
  if (country_code && NA_COUNTRY_CODES.has(country_code)) {
    // Pirate Weather → Open-Meteo → WeatherAPI → Tomorrow.io → OpenWeather
    const pirateKey = Deno.env.get("PIRATE_WEATHER_API_KEY");
    if (pirateKey) {
      return ["pirate_weather", "open_meteo", "weatherapi", "tomorrow_io", "openweather"];
    }
    // 若 Pirate Weather key 未設定，回退至全球預設
  }
  return defaultProviderPriority();
}

// ── 統一抓取介面 ────────────────────────────────────────────────────────────

export async function fetchForecastWithProvider(params: {
  provider: Exclude<WxProvider, "auto" | "nova_ensemble">;
  lat: number;
  lon: number;
  hours: number;
  days: number;
}): Promise<{
  provider: Exclude<WxProvider, "auto" | "nova_ensemble">;
  timezone: string;
  fetched_at: string;
  source_latency_ms: number | null;
  hourly: any[];
  daily: any[];
}> {
  const { provider, lat, lon, hours, days } = params;

  if (provider === "open_meteo") {
    const r = await fetchOpenMeteoForecast({ lat, lon, hours, days });
    return { provider, ...r };
  }

  if (provider === "met_norway") {
    const r = await fetchMetNorwayForecast({ lat, lon, hours, days });
    return { provider, ...r };
  }

  if (provider === "pirate_weather") {
    const apiKey = Deno.env.get("PIRATE_WEATHER_API_KEY");
    if (!apiKey) throw new Error("Missing PIRATE_WEATHER_API_KEY");
    const r = await fetchPirateWeatherForecast({ lat, lon, hours, days, apiKey });
    return { provider, ...r };
  }

  if (provider === "weatherapi") {
    const apiKey = Deno.env.get("WEATHER_API_KEY");
    if (!apiKey) throw new Error("Missing WEATHER_API_KEY");
    const r = await fetchWeatherApiForecast({ lat, lon, hours, days, apiKey });
    return { provider, ...r };
  }

  if (provider === "tomorrow_io") {
    const apiKey = Deno.env.get("TOMORROW_IO_API_KEY");
    if (!apiKey) throw new Error("Missing TOMORROW_IO_API_KEY");
    const r = await fetchTomorrowIoForecast({ lat, lon, hours, days, apiKey });
    return { provider, ...r };
  }

  if (provider === "openweather") {
    const apiKey = Deno.env.get("OPENWEATHER_API_KEY");
    if (!apiKey) throw new Error("Missing OPENWEATHER_API_KEY");
    const r = await fetchOpenWeatherForecast({ lat, lon, hours, days, apiKey });
    return { provider, ...r };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}
