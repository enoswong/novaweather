-- ============================================================
-- v0.5.0: Air Quality series, METAR observations, alert feed cleanup
-- ============================================================

-- wx_air_quality_series: hourly air quality from Open-Meteo Air Quality API
CREATE TABLE IF NOT EXISTS wx_air_quality_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  geohash char(6) NOT NULL,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  valid_time timestamptz NOT NULL,
  pm10 double precision,
  pm2_5 double precision,
  carbon_monoxide double precision,
  nitrogen_dioxide double precision,
  sulphur_dioxide double precision,
  ozone double precision,
  aerosol_optical_depth double precision,
  dust double precision,
  uv_index double precision,
  uv_index_clear_sky double precision,
  alder_pollen double precision,
  birch_pollen double precision,
  grass_pollen double precision,
  mugwort_pollen double precision,
  olive_pollen double precision,
  ragweed_pollen double precision,
  us_aqi integer,
  european_aqi integer,
  provider text NOT NULL DEFAULT 'open_meteo',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (geohash, valid_time, provider)
);

CREATE INDEX IF NOT EXISTS wx_air_quality_geohash_valid ON wx_air_quality_series(geohash, valid_time DESC);
CREATE INDEX IF NOT EXISTS wx_air_quality_valid_time ON wx_air_quality_series(valid_time DESC);

ALTER TABLE wx_air_quality_series ENABLE ROW LEVEL SECURITY;
CREATE POLICY "aq_public_read" ON wx_air_quality_series FOR SELECT USING (true);
CREATE POLICY "aq_service_write" ON wx_air_quality_series FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE wx_air_quality_series IS 'Hourly air quality data from Open-Meteo Air Quality API';

-- wx_metar_observations: METAR surface observations from NOAA Aviation Weather Center
CREATE TABLE IF NOT EXISTS wx_metar_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id text NOT NULL,
  geohash char(6),
  lat double precision,
  lon double precision,
  elevation_m double precision,
  observation_time timestamptz NOT NULL,
  temp_c double precision,
  dewpoint_c double precision,
  humidity_pct double precision,
  wind_dir_deg integer,
  wind_speed_ms double precision,
  wind_gust_ms double precision,
  visibility_m double precision,
  pressure_hpa double precision,
  pressure_sea_level_hpa double precision,
  cloud_cover_pct integer,
  weather_code text,
  weather_desc text,
  raw_metar text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (station_id, observation_time)
);

CREATE INDEX IF NOT EXISTS wx_metar_geohash_time ON wx_metar_observations(geohash, observation_time DESC);
CREATE INDEX IF NOT EXISTS wx_metar_station_time ON wx_metar_observations(station_id, observation_time DESC);
CREATE INDEX IF NOT EXISTS wx_metar_obs_time ON wx_metar_observations(observation_time DESC);

ALTER TABLE wx_metar_observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "metar_public_read" ON wx_metar_observations FOR SELECT USING (true);
CREATE POLICY "metar_service_write" ON wx_metar_observations FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE wx_metar_observations IS 'METAR surface observations from NOAA Aviation Weather Center (35 global priority stations)';

-- Add NWS GeoJSON feed (no auth required, returns structured GeoJSON with polygon geometry)
INSERT INTO wx_alert_feeds (source, country_code, url, is_enabled)
VALUES ('NWS_GEOJSON', 'US', 'https://api.weather.gov/alerts/active?status=actual&message_type=alert', true)
ON CONFLICT DO NOTHING;

-- Fix EnvironmentCanada: disable broken feed URL
UPDATE wx_alert_feeds
SET is_enabled = false
WHERE source = 'EnvironmentCanada';

-- Disable oversized MeteoAlarm all-Europe feed (causes timeouts)
UPDATE wx_alert_feeds
SET is_enabled = false
WHERE source = 'MeteoAlarm' AND url LIKE '%meteoalarm-legacy-atom-europe%';

-- Add NWS GeoJSON cron (every 10 min)
SELECT cron.schedule(
  'novaweather_alerts_ingest_nws',
  '*/10 * * * *',
  $$select net.http_post(url := 'https://whajwzbqracxpydpooyp.supabase.co/functions/v1/wx-alerts-ingest-nws', body := '{}'::jsonb);$$
) WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'novaweather_alerts_ingest_nws');

-- Add air quality hotspot refresh cron (every 3 hours)
SELECT cron.schedule(
  'novaweather_refresh_airquality_hotspots',
  '5 */3 * * *',
  $$select net.http_post(url := 'https://whajwzbqracxpydpooyp.supabase.co/functions/v1/wx-refresh-airquality-hotspots', body := '{}'::jsonb);$$
) WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'novaweather_refresh_airquality_hotspots');

-- Add METAR ingest cron (every 30 min, staggered)
SELECT cron.schedule(
  'novaweather_observed_metar',
  '15,45 * * * *',
  $$select net.http_post(url := 'https://whajwzbqracxpydpooyp.supabase.co/functions/v1/wx-observed-metar', body := '{}'::jsonb);$$
) WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'novaweather_observed_metar');
