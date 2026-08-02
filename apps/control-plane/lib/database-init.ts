import type { Pool } from "@neondatabase/serverless";

// The control plane can start on a serverless platform without a migration job.
// Every statement is idempotent so concurrent cold starts are safe.
export const schema = [
  "CREATE EXTENSION IF NOT EXISTS pgcrypto",
  "CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK (price_cents >= 0), tunnels INTEGER NOT NULL, traffic_gb INTEGER NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, region TEXT NOT NULL, capabilities JSONB NOT NULL DEFAULT '[\"cdn\", \"frp\"]'::jsonb, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('online','offline','pending')), address TEXT, last_seen TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS node_tokens (node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE, token_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS tunnels (id TEXT PRIMARY KEY, name TEXT NOT NULL, plan_id TEXT NOT NULL REFERENCES plans(id), node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL, local_addr TEXT NOT NULL, remote_port INTEGER NOT NULL CHECK (remote_port BETWEEN 1024 AND 65535), ticket TEXT NOT NULL UNIQUE, ticket_expires_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','disabled','suspended')), owner_id TEXT NOT NULL DEFAULT 'admin', created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS agent_commands (id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, type TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), claimed_at TIMESTAMPTZ, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)",
  "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('owner','operator','viewer')), expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, plan_id TEXT NOT NULL REFERENCES plans(id), amount_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','cancelled')), created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS billing_events (event_id TEXT PRIMARY KEY, provider TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS cdn_routes (id TEXT PRIMARY KEY, hostname TEXT NOT NULL UNIQUE, origin TEXT NOT NULL, cache_seconds INTEGER NOT NULL DEFAULT 60, plan_id TEXT NOT NULL REFERENCES plans(id), node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL, owner_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','suspended')), created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS agent_usage_reports (report_id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS usage_counters (period_start DATE NOT NULL, node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, owner_id TEXT NOT NULL, plan_id TEXT NOT NULL REFERENCES plans(id), resource_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('tunnel','cdn')), bytes BIGINT NOT NULL DEFAULT 0 CHECK (bytes >= 0), PRIMARY KEY (period_start,node_id,resource_id,kind))",
  "CREATE TABLE IF NOT EXISTS agent_resource_state (node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, payload JSONB NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (node_id,resource_type,resource_id))",
  "ALTER TABLE tunnels ADD COLUMN IF NOT EXISTS ticket_expires_at TIMESTAMPTZ",
  "ALTER TABLE tunnels ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft'",
  "ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS last_error TEXT",
  "ALTER TABLE cdn_routes ADD COLUMN IF NOT EXISTS plan_id TEXT",
  "ALTER TABLE tunnels DROP CONSTRAINT IF EXISTS tunnels_status_check",
  "ALTER TABLE tunnels ADD CONSTRAINT tunnels_status_check CHECK (status IN ('draft','active','disabled','suspended'))",
  "ALTER TABLE cdn_routes DROP CONSTRAINT IF EXISTS cdn_routes_status_check",
  "ALTER TABLE cdn_routes ADD CONSTRAINT cdn_routes_status_check CHECK (status IN ('draft','active','suspended'))",
  "UPDATE tunnels SET ticket_expires_at = created_at + interval '24 hours' WHERE ticket_expires_at IS NULL",
  "UPDATE cdn_routes SET plan_id = 'starter' WHERE plan_id IS NULL",
  "ALTER TABLE tunnels ALTER COLUMN ticket_expires_at SET NOT NULL",
  "ALTER TABLE cdn_routes ALTER COLUMN plan_id SET NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS tunnels_node_remote_port_active_idx ON tunnels (node_id,remote_port) WHERE node_id IS NOT NULL AND status IN ('draft','active','suspended')",
  "CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs (created_at DESC)",
  "CREATE INDEX IF NOT EXISTS usage_counters_owner_period_idx ON usage_counters (owner_id,period_start)",
  "INSERT INTO plans (id,name,price_cents,tunnels,traffic_gb) VALUES ('starter','Starter',1900,3,100),('growth','Growth',6900,15,1024),('scale','Scale',19900,-1,5120) ON CONFLICT (id) DO NOTHING",
];

export async function initializeDatabase(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // Serialize first-request schema setup across independently cold-started Edge instances.
    await client.query("SELECT pg_advisory_lock(hashtext('infnet_schema_v1'))");
    await client.query("BEGIN");
    for (const statement of schema) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('infnet_schema_v1'))").catch(() => undefined);
    client.release();
  }
}

// Edge runtimes should use Neon HTTP transactions instead of a WebSocket Pool
// for schema setup. All statements are trusted application SQL.
export async function initializeDatabaseHttp(sql: any): Promise<void> {
  const queries = [sql`SELECT pg_advisory_xact_lock(hashtext('infnet_schema_v1'))`, ...schema.map((statement) => sql`${sql.unsafe(statement)}`)];
  await sql.transaction(queries);
}
