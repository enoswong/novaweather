-- wx_webhook_subscriptions + wx_webhook_deliveries
-- Phase D: webhook delivery system

CREATE TABLE IF NOT EXISTS wx_webhook_subscriptions (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_key       TEXT          NOT NULL,
  callback_url    TEXT          NOT NULL,
  event_types     TEXT[]        NOT NULL DEFAULT ARRAY['alert_new']::TEXT[],
  lat             DOUBLE PRECISION,
  lon             DOUBLE PRECISION,
  radius_km       INTEGER       NOT NULL DEFAULT 50,
  secret          TEXT,                               -- HMAC-SHA256 signing secret
  active          BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  last_fired_at   TIMESTAMPTZ,
  fire_count      INTEGER       NOT NULL DEFAULT 0,
  failure_count   INTEGER       NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_wx_webhook_subs_owner
  ON wx_webhook_subscriptions(owner_key);
CREATE INDEX IF NOT EXISTS idx_wx_webhook_subs_active
  ON wx_webhook_subscriptions(active)
  WHERE active = TRUE;

-- Delivery audit log
CREATE TABLE IF NOT EXISTS wx_webhook_deliveries (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id  UUID        NOT NULL
    REFERENCES wx_webhook_subscriptions(id) ON DELETE CASCADE,
  event_type       TEXT        NOT NULL,
  payload          JSONB       NOT NULL,
  status_code      INTEGER,
  success          BOOLEAN     NOT NULL DEFAULT FALSE,
  attempted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_ms      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_wx_webhook_del_sub
  ON wx_webhook_deliveries(subscription_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_wx_webhook_del_attempted
  ON wx_webhook_deliveries(attempted_at DESC);

-- RLS: service role only (Edge Functions use service role key)
ALTER TABLE wx_webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wx_webhook_deliveries    ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_all_webhook_subs" ON wx_webhook_subscriptions
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "service_all_webhook_del" ON wx_webhook_deliveries
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- Auto-prune delivery log older than 7 days
SELECT cron.schedule(
  'novaweather_prune_webhook_deliveries',
  '15 3 * * *',
  $$DELETE FROM wx_webhook_deliveries WHERE attempted_at < NOW() - INTERVAL '7 days'$$
);
