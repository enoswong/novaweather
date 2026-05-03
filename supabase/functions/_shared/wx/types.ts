// 修改說明：定義 /wx/* 統一資料契約型別（SI 單位、缺值策略）
// 影響文件：supabase/functions/_shared/wx/types.ts

export type WxProvider =
  | "auto"
  | "open_meteo"
  | "weatherapi"
  | "tomorrow_io"
  | "openweather";

export type WxRiskLevel = 0 | 1 | 2 | 3;

export type WxPointMeta = {
  provider: Exclude<WxProvider, "auto">;
  fetched_at: string; // ISO8601 UTC
  source_latency_ms: number | null;
  confidence: number | null; // 0..1
};

export type WxHourlyPoint = {
  valid_time: string; // ISO8601 UTC

  temp_c: number | null;
  feels_like_c: number | null;
  humidity_pct: number | null;
  dewpoint_c: number | null;
  pressure_hpa: number | null;

  wind_ms: number | null;
  wind_dir_deg: number | null;
  gust_ms: number | null;

  precip_mm: number | null;
  precip_prob: number | null; // 0..1
  snow_mm: number | null;

  cloud_pct: number | null;
  visibility_m: number | null;
  uv_index: number | null;

  provider: Exclude<WxProvider, "auto">;
  fetched_at: string;
  confidence: number | null;
};

export type WxHourlyForecastResponse = {
  meta: {
    provider: Exclude<WxProvider, "auto">;
    fetched_at: string;
    timezone: string;
    lat: number;
    lon: number;
    geohash: string;
    place_id?: string | null;
    country_code?: string | null;
    admin1?: string | null;
    admin2?: string | null;
    admin3?: string | null;
    admin4?: string | null;
    locality?: string | null;
    name?: string | null;
    hours: number;
  };
  hourly: WxHourlyPoint[];
};

export type WxDailyPoint = {
  // YYYY-MM-DD in UTC. All providers are normalised to UTC day boundaries:
  //   - Open-Meteo: timezone=UTC enforced (was: timezone=auto → local date, bug)
  //   - WeatherAPI: date string is local but accepted as-is (backup provider only)
  //   - Tomorrow.io: UTC ISO timestamp → getUTC* extraction (correct)
  //   - OpenWeather: Unix dt → getUTC* extraction (correct)
  // DB queries use todayUtc() which is consistent with this UTC anchoring.
  date: string;

  t_min_c: number | null;
  t_max_c: number | null;
  precip_sum_mm: number | null;
  precip_prob_max: number | null; // 0..1
  wind_max_ms: number | null;
  uv_max: number | null;

  provider: Exclude<WxProvider, "auto">;
  fetched_at: string;
  confidence: number | null;
};

export type WxDailyForecastResponse = {
  meta: {
    provider: Exclude<WxProvider, "auto">;
    fetched_at: string;
    timezone: string;
    lat: number;
    lon: number;
    geohash: string;
    place_id?: string | null;
    country_code?: string | null;
    admin1?: string | null;
    admin2?: string | null;
    admin3?: string | null;
    admin4?: string | null;
    locality?: string | null;
    name?: string | null;
    days: number;
  };
  daily: WxDailyPoint[];
};

export type WxAlert = {
  id: string;
  source: string;
  severity: "info" | "yellow" | "orange" | "red" | "emergency";
  title: string;
  description: string | null;
  starts_at: string | null;
  ends_at: string | null;
};

export type WxAlertsResponse = {
  meta: {
    fetched_at: string;
    lat: number;
    lon: number;
    radius_km: number;
    place_id?: string | null;
    country_code?: string | null;
    admin1?: string | null;
    admin2?: string | null;
    admin3?: string | null;
    admin4?: string | null;
    locality?: string | null;
    name?: string | null;
  };
  alerts: WxAlert[];
};

export type WxRiskReason = {
  code:
    | "temp_drop_gt_4c"
    | "diurnal_temp_range_gt_8c"
    | "humidity_gt_90"
    | "humidity_lt_40"
    | "heavy_rain_prob"
    | "strong_wind"
    | "official_alert"
    | "heat_extreme"
    | "cold_extreme"
    | "dry_air"
    | "storm_condition";
  severity: 0 | 1 | 2 | 3;
  details: Record<string, unknown>;
};

export type WxRiskResponse = {
  meta: {
    fetched_at: string;
    lat: number;
    lon: number;
    window_hours: number;
    radius_km?: number;
    place_id?: string | null;
    country_code?: string | null;
    admin1?: string | null;
    admin2?: string | null;
    admin3?: string | null;
    admin4?: string | null;
    locality?: string | null;
    name?: string | null;
  };
  risk_level: WxRiskLevel;
  reasons: WxRiskReason[];
};

export type WxTimelinePointRisk = {
  risk_level: WxRiskLevel;
  reasons: WxRiskReason[];
  tags: string[];
};

export type WxEnvironmentMinutePoint = {
  valid_time: string;
  temp_c: number | null;
  humidity_pct: number | null;
  precip_prob: number | null;
  wind_ms: number | null;
  gust_ms: number | null;
  risk: WxTimelinePointRisk;
};

export type WxEnvironmentHourlyPoint = WxHourlyPoint & {
  risk: WxTimelinePointRisk;
};

export type WxEnvironmentDailyPoint = WxDailyPoint & {
  risk: WxTimelinePointRisk;
};

export type WxEnvironmentTimelineResponse = {
  meta: {
    fetched_at: string;
    provider: Exclude<WxProvider, "auto">;
    timezone: string;
    lat: number;
    lon: number;
    geohash: string;
    place_id?: string | null;
    country_code?: string | null;
    admin1?: string | null;
    admin2?: string | null;
    admin3?: string | null;
    admin4?: string | null;
    locality?: string | null;
    name?: string | null;
    window_hours: number;
    days: number;
    minute_window: number;
    radius_km: number;
  };
  alerts_summary: {
    active_count: number;
  };
  now: {
    observed: WxHourlyPoint | null;
    risk: WxTimelinePointRisk | null;
  };
  minute: WxEnvironmentMinutePoint[];
  hourly: WxEnvironmentHourlyPoint[];
  daily: WxEnvironmentDailyPoint[];
};

