-- ============================================================
-- v1.0.0: wx_hourly_series 月分區（RANGE by valid_time）
-- ============================================================
-- 背景：核心時間序列，每個 hotspot × 每小時 × 多 provider 寫入一列，資料量最大。
-- 現有 PK：(geohash, valid_time, kind, provider) — 已包含 valid_time，
-- 因此 RANGE by valid_time 天然相容，不需修改 PK 結構。
-- ============================================================

BEGIN;

-- Step 1: 建立新分區父表（LIKE INCLUDING ALL 複製所有 constraint + index）
CREATE TABLE IF NOT EXISTS public.wx_hourly_series_p (
  geohash       TEXT          NOT NULL,
  valid_time    TIMESTAMPTZ   NOT NULL,
  kind          TEXT          NOT NULL CHECK (kind IN ('observed', 'forecast')),

  temp_c        DOUBLE PRECISION,
  feels_like_c  DOUBLE PRECISION,
  humidity_pct  DOUBLE PRECISION,
  dewpoint_c    DOUBLE PRECISION,
  pressure_hpa  DOUBLE PRECISION,

  wind_ms       DOUBLE PRECISION,
  wind_dir_deg  DOUBLE PRECISION,
  gust_ms       DOUBLE PRECISION,

  precip_mm     DOUBLE PRECISION,
  precip_prob   DOUBLE PRECISION,
  snow_mm       DOUBLE PRECISION,

  cloud_pct     DOUBLE PRECISION,
  visibility_m  DOUBLE PRECISION,
  uv_index      DOUBLE PRECISION,

  provider      TEXT          NOT NULL,
  fetched_at    TIMESTAMPTZ   NOT NULL,
  confidence    DOUBLE PRECISION,

  -- 複合 PK 必須包含分區鍵（valid_time），現有 PK 已滿足此條件
  PRIMARY KEY (geohash, valid_time, kind, provider)
) PARTITION BY RANGE (valid_time);

-- Step 2: 建立月分區
CREATE TABLE IF NOT EXISTS public.wx_hourly_series_2026_04
  PARTITION OF public.wx_hourly_series_p
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

CREATE TABLE IF NOT EXISTS public.wx_hourly_series_2026_05
  PARTITION OF public.wx_hourly_series_p
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE IF NOT EXISTS public.wx_hourly_series_2026_06
  PARTITION OF public.wx_hourly_series_p
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE IF NOT EXISTS public.wx_hourly_series_2026_07
  PARTITION OF public.wx_hourly_series_p
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE TABLE IF NOT EXISTS public.wx_hourly_series_2026_08
  PARTITION OF public.wx_hourly_series_p
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

CREATE TABLE IF NOT EXISTS public.wx_hourly_series_2026_09
  PARTITION OF public.wx_hourly_series_p
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

-- DEFAULT 分區：承接超範圍資料（日後查詢歷史或未來遠端預報用）
CREATE TABLE IF NOT EXISTS public.wx_hourly_series_default
  PARTITION OF public.wx_hourly_series_p
  DEFAULT;

-- Step 3: 父表額外索引（傳播至所有子分區）
CREATE INDEX IF NOT EXISTS wx_hourly_series_p_geohash_time_desc_idx
  ON public.wx_hourly_series_p (geohash, valid_time DESC);

CREATE INDEX IF NOT EXISTS wx_hourly_series_p_kind_idx
  ON public.wx_hourly_series_p (kind);

-- Step 4: 遷移現有資料
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'wx_hourly_series'
    AND table_type = 'BASE TABLE'
  ) THEN
    INSERT INTO public.wx_hourly_series_p (
      geohash, valid_time, kind,
      temp_c, feels_like_c, humidity_pct, dewpoint_c, pressure_hpa,
      wind_ms, wind_dir_deg, gust_ms,
      precip_mm, precip_prob, snow_mm,
      cloud_pct, visibility_m, uv_index,
      provider, fetched_at, confidence
    )
    SELECT
      geohash, valid_time, kind,
      temp_c, feels_like_c, humidity_pct, dewpoint_c, pressure_hpa,
      wind_ms, wind_dir_deg, gust_ms,
      precip_mm, precip_prob, snow_mm,
      cloud_pct, visibility_m, uv_index,
      provider, fetched_at, confidence
    FROM public.wx_hourly_series
    ON CONFLICT (geohash, valid_time, kind, provider) DO NOTHING;

    -- 保留舊表作備份
    ALTER TABLE public.wx_hourly_series RENAME TO wx_hourly_series_legacy;
  END IF;
END $$;

-- Step 5: 重命名分區父表
ALTER TABLE IF EXISTS public.wx_hourly_series_p
  RENAME TO wx_hourly_series;

-- Step 6: RLS
ALTER TABLE public.wx_hourly_series ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'wx_hourly_series'
      AND policyname = 'service_all_hourly_series'
  ) THEN
    CREATE POLICY "service_all_hourly_series" ON public.wx_hourly_series
      FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
    CREATE POLICY "anon_read_hourly_series" ON public.wx_hourly_series
      FOR SELECT TO anon, authenticated USING (TRUE);
  END IF;
END $$;

-- Step 7: 更新 prune cron（分區後 DROP TABLE 比 DELETE 更快，
-- 但現階段保留 DELETE 以維持操作一致性；可在 v1.1 改為 DROP PARTITION）
SELECT cron.unschedule('novaweather_prune_time_series')
  FROM cron.job
  WHERE jobname = 'novaweather_prune_time_series';

SELECT cron.schedule(
  'novaweather_prune_time_series',
  '41 2 * * *',
  $$select net.http_post(
    url := 'https://whajwzbqracxpydpooyp.supabase.co/functions/v1/wx-prune-time-series',
    body := '{}'::jsonb
  );$$
);

COMMIT;
