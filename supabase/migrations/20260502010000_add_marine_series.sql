-- ============================================================
-- v0.6.0: Marine wave series + Phase B maintenance cron
-- ============================================================

-- wx_marine_series: hourly marine forecast from Open-Meteo Marine API
CREATE TABLE IF NOT EXISTS wx_marine_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  geohash char(6) NOT NULL,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  valid_time timestamptz NOT NULL,
  wave_height_m double precision,
  wave_direction_deg double precision,
  wave_period_s double precision,
  wind_wave_height_m double precision,
  wind_wave_direction_deg double precision,
  wind_wave_period_s double precision,
  swell_wave_height_m double precision,
  swell_wave_direction_deg double precision,
  swell_wave_period_s double precision,
  sea_surface_temperature_c double precision,
  ocean_current_velocity_ms double precision,
  ocean_current_direction_deg double precision,
  provider text NOT NULL DEFAULT 'open_meteo_marine',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (geohash, valid_time, provider)
);

CREATE INDEX IF NOT EXISTS wx_marine_geohash_valid ON wx_marine_series(geohash, valid_time DESC);
CREATE INDEX IF NOT EXISTS wx_marine_valid_time ON wx_marine_series(valid_time DESC);

ALTER TABLE wx_marine_series ENABLE ROW LEVEL SECURITY;
CREATE POLICY "marine_public_read" ON wx_marine_series FOR SELECT USING (true);
CREATE POLICY "marine_service_write" ON wx_marine_series FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE wx_marine_series IS 'Hourly marine wave and current forecast from Open-Meteo Marine API (coastal locations only)';

-- Add marine hotspot refresh cron (every 6 hours, staggered)
SELECT cron.schedule(
  'novaweather_refresh_marine_hotspots',
  '35 */6 * * *',
  $$select net.http_post(url := 'https://whajwzbqracxpydpooyp.supabase.co/functions/v1/wx-refresh-marine-hotspots', body := '{}'::jsonb);$$
) WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'novaweather_refresh_marine_hotspots');
