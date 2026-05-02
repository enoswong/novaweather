// 修改說明：供應商優先序 + 熔斷檢查 + 統一抓取介面
// 影響文件：supabase/functions/_shared/wx/provider_chain.ts

import type { WxProvider } from "./types.ts";
import { fetchOpenMeteoForecast } from "./providers/open_meteo.ts";
import { fetchWeatherApiForecast } from "./providers/weatherapi.ts";
import { fetchTomorrowIoForecast } from "./providers/tomorrow_io.ts";
import { fetchOpenWeatherForecast } from "./providers/openweather.ts";

export function defaultProviderPriority(): Exclude<WxProvider, "auto">[] {
  return ["open_meteo", "weatherapi", "tomorrow_io", "openweather"];
}

export async function fetchForecastWithProvider(params: {
  provider: Exclude<WxProvider, "auto">;
  lat: number;
  lon: number;
  hours: number;
  days: number;
}): Promise<{
  provider: Exclude<WxProvider, "auto">;
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

