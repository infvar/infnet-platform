ALTER TABLE cdn_routes ADD COLUMN IF NOT EXISTS plan_id TEXT;
UPDATE cdn_routes SET plan_id = 'starter' WHERE plan_id IS NULL;
ALTER TABLE cdn_routes ALTER COLUMN plan_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE cdn_routes ADD CONSTRAINT cdn_routes_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES plans(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS agent_usage_reports (
  report_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_counters (
  period_start DATE NOT NULL,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  resource_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tunnel', 'cdn')),
  bytes BIGINT NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  PRIMARY KEY (period_start, node_id, resource_id, kind)
);
CREATE INDEX IF NOT EXISTS usage_counters_owner_period_idx ON usage_counters (owner_id, period_start);
