-- ============================================================
-- v1.0.0: Webhook 異步解耦 — wx_webhook_queue + fanout/worker cron
-- ============================================================
-- 問題背景：wx-webhook-dispatch 以 Promise.allSettled 並行發送所有訂閱的 HTTP POST，
-- 當訂閱數增長後，超過 Edge Function 30s 限制將靜默丟失尾部訂閱。
-- 解法：fanout 只寫 queue，worker 每分鐘取 50 筆批量發送，兩者各自在 30s 內完成。
-- ============================================================

-- 1. Webhook queue 表
CREATE TABLE IF NOT EXISTS public.wx_webhook_queue (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID        NOT NULL
    REFERENCES wx_webhook_subscriptions(id) ON DELETE CASCADE,
  payload         JSONB       NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sending', 'done', 'failed')),
  dedup_key       TEXT        UNIQUE,     -- 防止同一 alert×sub 重複入列
  scheduled_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at      TIMESTAMPTZ,
  done_at         TIMESTAMPTZ,
  attempts        INTEGER     NOT NULL DEFAULT 0,
  last_error      TEXT
);

-- 待處理查詢索引（worker 頻繁使用）
CREATE INDEX IF NOT EXISTS wx_webhook_queue_pending_idx
  ON public.wx_webhook_queue (status, scheduled_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS wx_webhook_queue_sub_idx
  ON public.wx_webhook_queue (subscription_id);

-- RLS
ALTER TABLE public.wx_webhook_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_all_webhook_queue" ON public.wx_webhook_queue
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- 2. 原子性批量認領函式（SKIP LOCKED 防止雙重處理）
-- worker 透過 RPC 呼叫此函式來安全地取出一批待發送的 webhook 任務
CREATE OR REPLACE FUNCTION public.wx_claim_webhook_queue(
  batch_size INTEGER DEFAULT 50
)
RETURNS TABLE (
  id              UUID,
  subscription_id UUID,
  payload         JSONB,
  attempts        INTEGER
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.wx_webhook_queue q
  SET
    status     = 'sending',
    claimed_at = NOW(),
    attempts   = q.attempts + 1
  WHERE q.id IN (
    SELECT wq.id
    FROM   public.wx_webhook_queue wq
    WHERE  wq.status = 'pending'
    ORDER  BY wq.scheduled_at
    LIMIT  batch_size
    FOR UPDATE SKIP LOCKED
  )
  RETURNING q.id, q.subscription_id, q.payload, q.attempts;
$$;

GRANT EXECUTE ON FUNCTION public.wx_claim_webhook_queue(INTEGER)
  TO service_role;

COMMENT ON FUNCTION public.wx_claim_webhook_queue IS
  'Atomically claims up to batch_size pending webhook queue items, '
  'marking them as ''sending'' via SKIP LOCKED to prevent duplicate processing.';

-- 3. 自動清理：每天 03:37 UTC 刪除 7 天前已完成/失敗的任務
SELECT cron.unschedule('novaweather_prune_webhook_queue')
  FROM cron.job
  WHERE jobname = 'novaweather_prune_webhook_queue';

SELECT cron.schedule(
  'novaweather_prune_webhook_queue',
  '37 3 * * *',
  $$
    DELETE FROM public.wx_webhook_queue
    WHERE  status IN ('done', 'failed')
      AND  done_at < NOW() - INTERVAL '7 days'
  $$
);

-- 4. 切換到 fanout + worker 模式（移除舊的 dispatch cron，改為拆分兩個 cron）
--    注意：若 novaweather_webhook_dispatch 不存在，unschedule 靜默忽略
SELECT cron.unschedule('novaweather_webhook_dispatch')
  FROM cron.job
  WHERE jobname = 'novaweather_webhook_dispatch';

-- fanout：每 5 分鐘掃描新警報並寫入 queue
SELECT cron.unschedule('novaweather_webhook_fanout')
  FROM cron.job
  WHERE jobname = 'novaweather_webhook_fanout';

SELECT cron.schedule(
  'novaweather_webhook_fanout',
  '*/5 * * * *',
  $$SELECT net.http_post(
    url := 'https://whajwzbqracxpydpooyp.supabase.co/functions/v1/wx-webhook-fanout',
    body := '{}'::jsonb
  );$$
);

-- worker：每分鐘認領並發送 ≤50 筆 queue 項目
SELECT cron.unschedule('novaweather_webhook_worker')
  FROM cron.job
  WHERE jobname = 'novaweather_webhook_worker';

SELECT cron.schedule(
  'novaweather_webhook_worker',
  '* * * * *',
  $$SELECT net.http_post(
    url := 'https://whajwzbqracxpydpooyp.supabase.co/functions/v1/wx-webhook-worker',
    body := '{}'::jsonb
  );$$
);
