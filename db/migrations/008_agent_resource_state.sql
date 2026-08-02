CREATE TABLE IF NOT EXISTS agent_resource_state (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, resource_type, resource_id)
);
