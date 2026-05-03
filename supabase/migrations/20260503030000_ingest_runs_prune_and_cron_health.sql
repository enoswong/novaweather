-- ============================================================
-- v0.9.1: wx_ingest_runs 清理排程 + wx_cron_status() RPC
-- ============================================================

-- 1. 每天 03:23 UTC 刪除 7 天以前的 wx_ingest_runs
--    （每次 API 呼叫寫一列，未清理將無上限成長）
SELECT cron.unschedule('novaweather_prune_ingest_runs')
  FROM cron.job
  WHERE jobname = 'novaweather_prune_ingest_runs';

SELECT cron.schedule(
  'novaweather_prune_ingest_runs',
  '23 3 * * *',
  $$DELETE FROM public.wx_ingest_runs WHERE finished_at < NOW() - INTERVAL '7 days'$$
);

-- 2. wx_cron_status()：對外暴露 pg_cron 工作狀態（供 wx-status 使用）
--    SECURITY DEFINER 以 postgres 身份存取 cron schema，
--    呼叫方（service_role）無需直接存取 cron.job。
CREATE OR REPLACE FUNCTION public.wx_cron_status()
RETURNS TABLE (
  jobname    TEXT,
  schedule   TEXT,
  active     BOOLEAN,
  next_run   TIMESTAMPTZ
)
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    j.jobname::TEXT,
    j.schedule::TEXT,
    j.active,
    j.next_run
  FROM cron.job j
  WHERE j.jobname LIKE 'novaweather_%'
  ORDER BY j.jobname;
$$;

GRANT EXECUTE ON FUNCTION public.wx_cron_status() TO service_role;
GRANT EXECUTE ON FUNCTION public.wx_cron_status() TO anon;
GRANT EXECUTE ON FUNCTION public.wx_cron_status() TO authenticated;

COMMENT ON FUNCTION public.wx_cron_status IS
  'Returns active pg_cron jobs for the novaweather_ prefix. SECURITY DEFINER to access cron schema.';
