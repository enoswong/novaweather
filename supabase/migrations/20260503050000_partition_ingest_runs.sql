-- ============================================================
-- v1.0.0: wx_ingest_runs 月分區（RANGE by finished_at）
-- ============================================================
-- 背景：每次 API 呼叫/cron 都寫入一列，無分區時表會無上限膨脹。
-- 現有表 PK 為 UUID only → 與 RANGE 分區不相容。
-- 解法：捨棄 UUID PK，改以 UNIQUE INDEX 保留 id 唯一性，
--       並加 btree 索引在 finished_at 供 RANGE 分區使用。
-- 注意：此表為純日誌表，無其他表的 FK 指向它，修改 PK 安全。
-- ============================================================

BEGIN;

-- Step 1: 建立新分區父表（結構與現有表相同，僅移除 UUID PK，加入分區定義）
CREATE TABLE IF NOT EXISTS public.wx_ingest_runs_p (
  id          UUID          NOT NULL DEFAULT gen_random_uuid(),
  provider    TEXT          NOT NULL,
  geohash     TEXT          NOT NULL,
  endpoint    TEXT          NOT NULL,
  started_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ   NOT NULL,
  latency_ms  INTEGER,
  status      TEXT          NOT NULL CHECK (status IN ('ok', 'error', 'skipped')),
  http_status INTEGER,
  error       TEXT
) PARTITION BY RANGE (finished_at);

-- Step 2: 建立月分區（含 DEFAULT 分區承接超範圍資料）
CREATE TABLE IF NOT EXISTS public.wx_ingest_runs_2026_04
  PARTITION OF public.wx_ingest_runs_p
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

CREATE TABLE IF NOT EXISTS public.wx_ingest_runs_2026_05
  PARTITION OF public.wx_ingest_runs_p
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE IF NOT EXISTS public.wx_ingest_runs_2026_06
  PARTITION OF public.wx_ingest_runs_p
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE IF NOT EXISTS public.wx_ingest_runs_2026_07
  PARTITION OF public.wx_ingest_runs_p
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE TABLE IF NOT EXISTS public.wx_ingest_runs_2026_08
  PARTITION OF public.wx_ingest_runs_p
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- DEFAULT 分區：承接所有不在上述範圍的資料（保底）
CREATE TABLE IF NOT EXISTS public.wx_ingest_runs_default
  PARTITION OF public.wx_ingest_runs_p
  DEFAULT;

-- Step 3: 父表索引（自動傳播至所有子分區）
CREATE INDEX IF NOT EXISTS wx_ingest_runs_p_finished_at_idx
  ON public.wx_ingest_runs_p (finished_at DESC);

CREATE INDEX IF NOT EXISTS wx_ingest_runs_p_geohash_endpoint_idx
  ON public.wx_ingest_runs_p (geohash, endpoint);

CREATE INDEX IF NOT EXISTS wx_ingest_runs_p_status_idx
  ON public.wx_ingest_runs_p (status);

-- UNIQUE index on id（替代 PK，保持 id 唯一性）
CREATE UNIQUE INDEX IF NOT EXISTS wx_ingest_runs_p_id_uq
  ON public.wx_ingest_runs_p (id);

-- Step 4: 遷移現有資料至分區父表
-- 若 wx_ingest_runs 已存在且有資料，搬移到新分區表
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'wx_ingest_runs'
    AND table_type = 'BASE TABLE'
  ) THEN
    INSERT INTO public.wx_ingest_runs_p (id, provider, geohash, endpoint, started_at, finished_at, latency_ms, status, http_status, error)
    SELECT
      id,
      provider,
      geohash,
      endpoint,
      COALESCE(started_at, finished_at),
      finished_at,
      latency_ms,
      status,
      http_status,
      error
    FROM public.wx_ingest_runs
    ON CONFLICT (id) DO NOTHING;

    -- 重命名舊表（保留備份）
    ALTER TABLE public.wx_ingest_runs RENAME TO wx_ingest_runs_legacy;
  END IF;
END $$;

-- Step 5: 將新分區表重命名為正式名稱
ALTER TABLE IF EXISTS public.wx_ingest_runs_p
  RENAME TO wx_ingest_runs;

-- Step 6: RLS（繼承自父表，子分區自動套用）
ALTER TABLE public.wx_ingest_runs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'wx_ingest_runs'
      AND policyname = 'service_all_ingest_runs'
  ) THEN
    CREATE POLICY "service_all_ingest_runs" ON public.wx_ingest_runs
      FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
  END IF;
END $$;

-- Step 7: 更新 pg_cron 清理 job（使用 DROP PARTITION 而非 DELETE）
-- 清理 job 仍使用 DELETE（PARTITION DROP 需要手動操作），維持 7 天保留期
SELECT cron.unschedule('novaweather_prune_ingest_runs')
  FROM cron.job
  WHERE jobname = 'novaweather_prune_ingest_runs';

SELECT cron.schedule(
  'novaweather_prune_ingest_runs',
  '23 3 * * *',
  $$DELETE FROM public.wx_ingest_runs WHERE finished_at < NOW() - INTERVAL '7 days'$$
);

COMMIT;
