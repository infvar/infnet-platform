import { Pool, neon } from "@neondatabase/serverless";
import { db, Node, Plan, Tunnel, Command, CommandResult } from "./store";
import { initializeDatabaseHttp } from "./database-init";

const databaseSsl = process.env.DATABASE_SSL === "false" ? false : {
  rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false",
  ...(process.env.DATABASE_SSL_CA ? { ca: process.env.DATABASE_SSL_CA.replace(/\\n/g, "\n") } : {}),
};
const rawPool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL_SIZE || 10), ssl: databaseSsl }) : null;
const httpSql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
let databaseReady: Promise<void> | null = null;
function withDatabaseTimeout<T>(promise: Promise<T>, milliseconds = 8000): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("database_timeout")), milliseconds))]);
}
function ensureDatabaseReady(): Promise<void> {
  if (!httpSql) return Promise.resolve();
  if (!databaseReady) databaseReady = withDatabaseTimeout(initializeDatabaseHttp(httpSql)).catch((error) => {
    console.error("[database] automatic initialization failed", error instanceof Error ? error.message : error);
    databaseReady = null;
    throw error;
  });
  return databaseReady;
}
export async function checkDatabase(): Promise<void> {
  if (!httpSql) throw new Error("DATABASE_URL is not configured");
  await ensureDatabaseReady();
  await withDatabaseTimeout(httpSql`SELECT 1`);
}
export const pool = rawPool ? new Proxy(rawPool, { get(target, property, receiver) { if (property === "query") return (...args: any[]) => ensureDatabaseReady().then(() => (target.query as any)(...args)); if (property === "connect") return (...args: any[]) => ensureDatabaseReady().then(() => (target.connect as any)(...args)); return Reflect.get(target, property, receiver); } }) as Pool : null;
export const databaseEnabled = Boolean(pool);
const nodeHeartbeatTimeoutSeconds = 60;

function mapPlan(row: any): Plan { return { id: row.id, name: row.name, price: Number(row.price_cents) / 100, tunnels: row.tunnels, trafficGb: row.traffic_gb, enabled: row.enabled }; }
function mapNode(row: any): Node { return { id: row.id, name: row.name, region: row.region, capabilities: row.capabilities, status: row.status, lastSeen: row.last_seen?.toISOString(), address: row.address }; }
function mapTunnel(row: any): Tunnel { return { id: row.id, name: row.name, planId: row.plan_id, nodeId: row.node_id || undefined, nodeAddress: row.node_address || undefined, localAddr: row.local_addr, remotePort: row.remote_port, ticket: row.ticket, ticketExpiresAt: row.ticket_expires_at?.toISOString() || "", status: row.status, ownerId: row.owner_id }; }

export async function listPlans(): Promise<Plan[]> { if (!pool) return db.plans.filter((p) => p.enabled); const result = await pool.query("SELECT * FROM plans WHERE enabled = true ORDER BY price_cents"); return result.rows.map(mapPlan); }
export async function listAllPlans(): Promise<Plan[]> { if (!pool) return db.plans; const result = await pool.query("SELECT * FROM plans ORDER BY price_cents"); return result.rows.map(mapPlan); }
export async function findPlan(id: string): Promise<Plan | undefined> { if (!pool) return db.plans.find((plan) => plan.id === id); const result = await pool.query("SELECT * FROM plans WHERE id = $1", [id]); return result.rows[0] ? mapPlan(result.rows[0]) : undefined; }
export async function insertPlan(input: Plan): Promise<Plan> { if (!pool) { db.plans.push(input); return input; } const result = await pool.query("INSERT INTO plans (id,name,price_cents,tunnels,traffic_gb,enabled) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [input.id, input.name, Math.round(input.price * 100), input.tunnels, input.trafficGb, input.enabled]); return mapPlan(result.rows[0]); }
export async function updatePlan(id: string, input: Partial<Plan>): Promise<Plan | undefined> { const current = await findPlan(id); if (!current) return undefined; const next = { ...current, ...input }; if (!pool) { Object.assign(current, next); return current; } const result = await pool.query("UPDATE plans SET name = $2, price_cents = $3, tunnels = $4, traffic_gb = $5, enabled = $6 WHERE id = $1 RETURNING *", [id, next.name, Math.round(next.price * 100), next.tunnels, next.trafficGb, next.enabled]); return result.rows[0] ? mapPlan(result.rows[0]) : undefined; }
export async function listNodes(): Promise<Node[]> {
  if (!pool) {
    const cutoff = Date.now() - nodeHeartbeatTimeoutSeconds * 1000;
    return db.nodes.map((node) => node.status === "online" && (!node.lastSeen || Date.parse(node.lastSeen) < cutoff) ? { ...node, status: "offline" } : node);
  }
  await pool.query("UPDATE nodes SET status = 'offline' WHERE status = 'online' AND (last_seen IS NULL OR last_seen < now() - make_interval(secs => $1))", [nodeHeartbeatTimeoutSeconds]);
  const result = await pool.query("SELECT * FROM nodes ORDER BY created_at DESC");
  return result.rows.map(mapNode);
}
export async function findNode(idOrName: string): Promise<Node | undefined> { if (!pool) return db.nodes.find((n) => n.id === idOrName || n.name === idOrName); const result = await pool.query("SELECT * FROM nodes WHERE id = $1 OR name = $1 LIMIT 1", [idOrName]); return result.rows[0] ? mapNode(result.rows[0]) : undefined; }
export async function findAvailableNode(id: string, capability: "cdn" | "frp"): Promise<Node | undefined> {
  const node = await findNode(id);
  if (!node || node.status !== "online" || !node.lastSeen || Date.parse(node.lastSeen) < Date.now() - nodeHeartbeatTimeoutSeconds * 1000 || !node.capabilities.includes(capability)) return undefined;
  return node;
}
function isNodeAvailable(node: Node, capability: "cdn" | "frp") {
  return node.status === "online" && Boolean(node.lastSeen) && Date.parse(node.lastSeen!) >= Date.now() - nodeHeartbeatTimeoutSeconds * 1000 && node.capabilities.includes(capability);
}
export async function listAvailableNodes(capability: "cdn" | "frp"): Promise<Node[]> {
  return (await listNodes()).filter((node) => isNodeAvailable(node, capability));
}
export async function listNodesWithCapability(capability: "cdn" | "frp"): Promise<Node[]> {
  return (await listNodes()).filter((node) => node.capabilities.includes(capability));
}
export async function insertNode(node: Node, token: string): Promise<void> { if (!pool) { db.nodes.push(node); db.nodeTokens.set(node.id, token); return; } const client = await pool.connect(); try { await client.query("BEGIN"); await client.query("INSERT INTO nodes (id,name,region,capabilities,status) VALUES ($1,$2,$3,$4,$5)", [node.id, node.name, node.region, JSON.stringify(node.capabilities), node.status]); await client.query("INSERT INTO node_tokens (node_id,token_hash) VALUES ($1,crypt($2,gen_salt('bf')))", [node.id, token]); await client.query("COMMIT"); } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); } }
export async function updateNodeSeen(node: Node): Promise<void> { if (!pool) { const current = db.nodes.find((n) => n.id === node.id); if (current) { current.status = node.status; current.lastSeen = node.lastSeen; if (node.address) current.address = node.address; } return; } await pool.query("UPDATE nodes SET status = $2, last_seen = now(), address = COALESCE(NULLIF($3,''),address) WHERE id = $1", [node.id, node.status, node.address || ""]); }
export type UsageInput = { resourceId: string; kind: "tunnel" | "cdn"; bytes: number };
export type UsageSummary = { planId: string; bytes: number; trafficGb: number; overQuota: boolean };
function currentUsagePeriod() { return `${new Date().toISOString().slice(0, 7)}-01`; }
export async function recordUsage(nodeId: string, reportId: string, reports: UsageInput[]): Promise<void> {
  if (!reportId || !reports.length) return;
  if (!pool) {
    if (db.usageReports.has(reportId)) return;
    db.usageReports.add(reportId);
    const period = currentUsagePeriod();
    for (const report of reports) {
      if (!Number.isSafeInteger(report.bytes) || report.bytes <= 0) continue;
      const tunnel = report.kind === "tunnel" ? db.tunnels.find((item) => item.id === report.resourceId && item.nodeId === nodeId) : undefined;
      const route = report.kind === "cdn" ? db.cdnRoutes.find((item) => item.id === report.resourceId) : undefined;
      const resource = tunnel || route;
      if (!resource) continue;
      const existing = db.usage.find((item) => item.period === period && item.nodeId === nodeId && item.resourceId === report.resourceId && item.kind === report.kind);
      if (existing) existing.bytes += report.bytes;
      else db.usage.push({ period, nodeId, ownerId: resource.ownerId, planId: resource.planId, resourceId: report.resourceId, kind: report.kind, bytes: report.bytes });
    }
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const accepted = await client.query("INSERT INTO agent_usage_reports (report_id,node_id) VALUES ($1,$2) ON CONFLICT (report_id) DO NOTHING RETURNING report_id", [reportId, nodeId]);
    if (!accepted.rowCount) { await client.query("COMMIT"); return; }
    for (const report of reports) {
      if (!Number.isSafeInteger(report.bytes) || report.bytes <= 0) continue;
      let resource: any;
      if (report.kind === "tunnel") resource = (await client.query("SELECT owner_id,plan_id FROM tunnels WHERE id = $1 AND node_id = $2", [report.resourceId, nodeId])).rows[0];
      else resource = (await client.query("SELECT owner_id,plan_id FROM cdn_routes WHERE id = $1", [report.resourceId])).rows[0];
      if (!resource) continue;
      await client.query("INSERT INTO usage_counters (period_start,node_id,owner_id,plan_id,resource_id,kind,bytes) VALUES (date_trunc('month', now())::date,$1,$2,$3,$4,$5,$6) ON CONFLICT (period_start,node_id,resource_id,kind) DO UPDATE SET bytes = usage_counters.bytes + EXCLUDED.bytes", [nodeId, resource.owner_id, resource.plan_id, report.resourceId, report.kind, report.bytes]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
export async function listUserUsage(userId: string): Promise<UsageSummary[]> {
  if (!pool) {
    const aggregate = new Map<string, number>();
    for (const item of db.usage.filter((entry) => entry.ownerId === userId && entry.period === currentUsagePeriod())) aggregate.set(item.planId, (aggregate.get(item.planId) || 0) + item.bytes);
    return Array.from(aggregate.entries()).map(([planId, bytes]) => { const plan = db.plans.find((item) => item.id === planId); const trafficGb = plan?.trafficGb || 0; return { planId, bytes, trafficGb, overQuota: trafficGb > 0 && bytes > trafficGb * 1024 ** 3 }; });
  }
  const result = await pool.query("SELECT u.plan_id, SUM(u.bytes)::numeric AS bytes, p.traffic_gb FROM usage_counters u JOIN plans p ON p.id = u.plan_id WHERE u.owner_id = $1 AND u.period_start = date_trunc('month', now())::date GROUP BY u.plan_id,p.traffic_gb ORDER BY u.plan_id", [userId]);
  return result.rows.map((row) => { const bytes = Number(row.bytes); const trafficGb = Number(row.traffic_gb); return { planId: row.plan_id, bytes, trafficGb, overQuota: trafficGb > 0 && bytes > trafficGb * 1024 ** 3 }; });
}
export async function hasTrafficCapacity(userId: string, planId: string): Promise<boolean> { const plan = await findPlan(planId); if (!plan || plan.trafficGb <= 0) return true; const usage = (await listUserUsage(userId)).find((item) => item.planId === planId); return !usage || usage.bytes < plan.trafficGb * 1024 ** 3; }
export async function reconcileUserPlanQuota(userId: string, planId: string): Promise<boolean> {
  const withinQuota = await hasTrafficCapacity(userId, planId);
  if (!pool) {
    const tunnels = db.tunnels.filter((item) => item.ownerId === userId && item.planId === planId);
    const routes = db.cdnRoutes.filter((item) => item.ownerId === userId && item.planId === planId);
    if (withinQuota) {
      for (const tunnel of tunnels.filter((item) => item.status === "suspended")) { tunnel.status = "draft"; if (tunnel.nodeId) await enqueueCommand(tunnel.nodeId, { id: `cmd_${crypto.randomUUID()}`, type: "apply_tunnel", payload: tunnel as unknown as Record<string, unknown>, createdAt: new Date().toISOString() }); }
      for (const route of routes.filter((item) => item.status === "suspended")) { route.status = "draft"; for (const node of await cdnTargetNodes(route)) await enqueueCommand(node.id, { id: `cmd_${crypto.randomUUID()}`, type: "apply_cdn", payload: route as unknown as Record<string, unknown>, createdAt: new Date().toISOString() }); }
      return false;
    }
    for (const tunnel of tunnels.filter((item) => item.status === "draft" || item.status === "active")) { tunnel.status = "suspended"; if (tunnel.nodeId) await enqueueCommand(tunnel.nodeId, { id: `cmd_${crypto.randomUUID()}`, type: "remove_tunnel", payload: tunnel as unknown as Record<string, unknown>, createdAt: new Date().toISOString() }); }
    for (const route of routes.filter((item) => item.status === "draft" || item.status === "active")) { route.status = "suspended"; for (const node of await cdnTargetNodes(route)) await enqueueCommand(node.id, { id: `cmd_${crypto.randomUUID()}`, type: "remove_cdn", payload: route as unknown as Record<string, unknown>, createdAt: new Date().toISOString() }); }
    return true;
  }
  if (withinQuota) {
    const tunnels = (await pool.query("UPDATE tunnels SET status = 'draft' WHERE owner_id = $1 AND plan_id = $2 AND status = 'suspended' RETURNING *", [userId, planId])).rows;
    const routes = (await pool.query("UPDATE cdn_routes SET status = 'draft' WHERE owner_id = $1 AND plan_id = $2 AND status = 'suspended' RETURNING *", [userId, planId])).rows;
    for (const row of tunnels) if (row.node_id) await enqueueCommand(row.node_id, { id: `cmd_${crypto.randomUUID()}`, type: "apply_tunnel", payload: mapTunnel(row) as unknown as Record<string, unknown>, createdAt: new Date().toISOString() });
    for (const row of routes) { const route = mapCdnRoute(row); for (const node of await cdnTargetNodes(route)) await enqueueCommand(node.id, { id: `cmd_${crypto.randomUUID()}`, type: "apply_cdn", payload: route as unknown as Record<string, unknown>, createdAt: new Date().toISOString() }); }
    return false;
  }
  const tunnels = (await pool.query("UPDATE tunnels SET status = 'suspended' WHERE owner_id = $1 AND plan_id = $2 AND status IN ('draft','active') RETURNING *", [userId, planId])).rows;
  const routes = (await pool.query("UPDATE cdn_routes SET status = 'suspended' WHERE owner_id = $1 AND plan_id = $2 AND status IN ('draft','active') RETURNING *", [userId, planId])).rows;
  for (const row of tunnels) if (row.node_id) await enqueueCommand(row.node_id, { id: `cmd_${crypto.randomUUID()}`, type: "remove_tunnel", payload: mapTunnel(row) as unknown as Record<string, unknown>, createdAt: new Date().toISOString() });
  for (const row of routes) { const route = mapCdnRoute(row); for (const node of await cdnTargetNodes(route)) await enqueueCommand(node.id, { id: `cmd_${crypto.randomUUID()}`, type: "remove_cdn", payload: route as unknown as Record<string, unknown>, createdAt: new Date().toISOString() }); }
  return true;
}
export async function reconcileReportedQuotas(nodeId: string, reports: UsageInput[]): Promise<void> {
  const keys = new Set<string>();
  for (const report of reports) {
    let resource: any;
    if (!pool) {
      const tunnel = report.kind === "tunnel" ? db.tunnels.find((item) => item.id === report.resourceId && item.nodeId === nodeId) : undefined;
      const route = report.kind === "cdn" ? db.cdnRoutes.find((item) => item.id === report.resourceId) : undefined;
      resource = tunnel || route;
    } else if (report.kind === "tunnel") resource = (await pool.query("SELECT owner_id,plan_id FROM tunnels WHERE id = $1 AND node_id = $2", [report.resourceId, nodeId])).rows[0];
    else resource = (await pool.query("SELECT owner_id,plan_id FROM cdn_routes WHERE id = $1", [report.resourceId])).rows[0];
    if (resource) keys.add(`${resource.owner_id || resource.ownerId}\x00${resource.plan_id || resource.planId}`);
  }
  for (const key of Array.from(keys)) { const [userId, planId] = key.split("\x00"); await reconcileUserPlanQuota(userId, planId); }
}
export async function reconcileSuspendedNodeQuotas(nodeId: string): Promise<void> {
  const keys = new Set<string>();
  if (!pool) {
    for (const item of db.tunnels.filter((entry) => entry.nodeId === nodeId && entry.status === "suspended")) keys.add(`${item.ownerId}\x00${item.planId}`);
    for (const item of db.cdnRoutes.filter((entry) => entry.status === "suspended")) keys.add(`${item.ownerId}\x00${item.planId}`);
  } else {
    const result = await pool.query("SELECT DISTINCT owner_id,plan_id FROM tunnels WHERE node_id = $1 AND status = 'suspended' UNION SELECT DISTINCT owner_id,plan_id FROM cdn_routes WHERE status = 'suspended'", [nodeId]);
    for (const row of result.rows) keys.add(`${row.owner_id}\x00${row.plan_id}`);
  }
  for (const key of Array.from(keys)) { const [userId, planId] = key.split("\x00"); await reconcileUserPlanQuota(userId, planId); }
}
export async function updateNodeMetadata(id: string, input: Pick<Node, "name" | "region" | "capabilities">): Promise<Node | undefined> { const current = await findNode(id); if (!current) return undefined; const next = { ...current, ...input }; if (!pool) { Object.assign(current, next); return current; } const result = await pool.query("UPDATE nodes SET name = $2, region = $3, capabilities = $4 WHERE id = $1 RETURNING *", [id, next.name, next.region, JSON.stringify(next.capabilities)]); return result.rows[0] ? mapNode(result.rows[0]) : undefined; }
export async function rotateNodeToken(id: string, token: string): Promise<boolean> { if (!pool) { if (!db.nodeTokens.has(id)) return false; db.nodeTokens.set(id, token); return true; } const result = await pool.query("UPDATE node_tokens SET token_hash = crypt($2, gen_salt('bf')) WHERE node_id = $1", [id, token]); return result.rowCount === 1; }
export async function validateNodeToken(nodeId: string, token: string): Promise<boolean> { if (!pool) return db.nodeTokens.get(nodeId) === token; const result = await pool.query("SELECT 1 FROM node_tokens WHERE node_id = $1 AND token_hash = crypt($2, token_hash)", [nodeId, token]); return result.rowCount === 1; }
export async function listTunnels(): Promise<Tunnel[]> { if (!pool) return db.tunnels; const result = await pool.query("SELECT * FROM tunnels ORDER BY created_at DESC"); return result.rows.map(mapTunnel); }
export async function insertTunnel(tunnel: Tunnel): Promise<Tunnel> { if (!pool) { db.tunnels.push(tunnel); return tunnel; } const result = await pool.query("INSERT INTO tunnels (id,name,plan_id,node_id,local_addr,remote_port,ticket,ticket_expires_at,status,owner_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *", [tunnel.id, tunnel.name, tunnel.planId, tunnel.nodeId || null, tunnel.localAddr, tunnel.remotePort, tunnel.ticket, tunnel.ticketExpiresAt, tunnel.status, tunnel.ownerId]); return mapTunnel(result.rows[0]); }
export async function insertUserTunnel(tunnel: Tunnel, maxTunnels: number): Promise<Tunnel | undefined> {
  if (!pool) {
    if (maxTunnels >= 0 && db.tunnels.filter((item) => item.ownerId === tunnel.ownerId && item.planId === tunnel.planId && item.status !== "disabled").length >= maxTunnels) return undefined;
    db.tunnels.push(tunnel);
    return tunnel;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${tunnel.ownerId}:${tunnel.planId}`]);
    if (maxTunnels >= 0) {
      const count = await client.query("SELECT count(*)::int AS count FROM tunnels WHERE owner_id = $1 AND plan_id = $2 AND status <> 'disabled'", [tunnel.ownerId, tunnel.planId]);
      if (count.rows[0].count >= maxTunnels) {
        await client.query("COMMIT");
        return undefined;
      }
    }
    const result = await client.query("INSERT INTO tunnels (id,name,plan_id,node_id,local_addr,remote_port,ticket,ticket_expires_at,status,owner_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *", [tunnel.id, tunnel.name, tunnel.planId, tunnel.nodeId || null, tunnel.localAddr, tunnel.remotePort, tunnel.ticket, tunnel.ticketExpiresAt, tunnel.status, tunnel.ownerId]);
    await client.query("COMMIT");
    return mapTunnel(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function tunnelPortInUse(nodeId: string, remotePort: number): Promise<boolean> {
  if (!pool) return db.tunnels.some((item) => item.nodeId === nodeId && item.remotePort === remotePort && item.status !== "disabled");
  const result = await pool.query("SELECT 1 FROM tunnels WHERE node_id = $1 AND remote_port = $2 AND status IN ('draft','active','suspended') LIMIT 1", [nodeId, remotePort]);
  return result.rowCount === 1;
}
export async function enqueueCommand(nodeId: string, command: Command): Promise<void> { if (!pool) { const queue = db.commands.get(nodeId) ?? []; queue.push(command); db.commands.set(nodeId, queue); return; } await pool.query("INSERT INTO agent_commands (id,node_id,type,payload,created_at) VALUES ($1,$2,$3,$4,$5)", [command.id, nodeId, command.type, command.payload, command.createdAt]); }
async function enqueueDesiredIfMissing(nodeId: string, type: string, payload: Record<string, unknown>) {
  const resourceId = typeof payload.id === "string" ? payload.id : "";
  if (!resourceId) return;
  if (!pool) {
    const queue = db.commands.get(nodeId) ?? [];
    if (queue.some((command) => command.type === type && command.payload.id === resourceId)) return;
  } else {
    const existing = await pool.query("SELECT 1 FROM agent_commands WHERE node_id = $1 AND type = $2 AND payload->>'id' = $3 LIMIT 1", [nodeId, type, resourceId]);
    if (existing.rowCount) return;
    const applied = await pool.query("SELECT 1 FROM agent_resource_state WHERE node_id = $1 AND resource_type = $2 AND resource_id = $3 AND payload = $4::jsonb LIMIT 1", [nodeId, type, resourceId, JSON.stringify(payload)]);
    if (applied.rowCount) return;
  }
  await enqueueCommand(nodeId, { id: `cmd_${crypto.randomUUID()}`, type, payload, createdAt: new Date().toISOString() });
}
export async function cdnTargetNodes(route: import("./store").CdnRoute): Promise<Node[]> {
  if (!route.nodeId) return listNodesWithCapability("cdn");
  const node = await findNode(route.nodeId);
  return node && node.capabilities.includes("cdn") ? [node] : [];
}
export async function syncNodeDesiredState(nodeId: string): Promise<void> {
  if (!pool) {
    for (const tunnel of db.tunnels.filter((item) => item.nodeId === nodeId && (item.status === "draft" || item.status === "active"))) await enqueueDesiredIfMissing(nodeId, "apply_tunnel", tunnel as unknown as Record<string, unknown>);
    for (const route of db.cdnRoutes.filter((item) => routeIsDeployable(item.status) && (!item.nodeId || item.nodeId === nodeId))) await enqueueDesiredIfMissing(nodeId, "apply_cdn", route as unknown as Record<string, unknown>);
    return;
  }
  const tunnels = await pool.query("SELECT t.*, n.address AS node_address FROM tunnels t LEFT JOIN nodes n ON n.id = t.node_id WHERE t.node_id = $1 AND t.status IN ('draft','active')", [nodeId]);
  for (const row of tunnels.rows) await enqueueDesiredIfMissing(nodeId, "apply_tunnel", mapTunnel(row) as unknown as Record<string, unknown>);
  const routes = await pool.query("SELECT * FROM cdn_routes WHERE status IN ('draft','active') AND (node_id IS NULL OR node_id = $1)", [nodeId]);
  for (const row of routes.rows) await enqueueDesiredIfMissing(nodeId, "apply_cdn", mapCdnRoute(row) as unknown as Record<string, unknown>);
}
function routeIsDeployable(status: import("./store").CdnRoute["status"]) { return status === "draft" || status === "active"; }
export async function claimCommands(nodeId: string): Promise<Command[]> { if (!pool) { const queue = db.commands.get(nodeId) ?? []; const cutoff = Date.now() - 60000; const claimed = queue.filter((command) => !command.claimedAt || command.claimedAt < cutoff).slice(0, 50); for (const command of claimed) command.claimedAt = Date.now(); return claimed; } const client = await pool.connect(); try { await client.query("BEGIN"); const result = await client.query("UPDATE agent_commands SET claimed_at = now(), attempts = attempts + 1 WHERE id IN (SELECT id FROM agent_commands WHERE node_id = $1 AND (claimed_at IS NULL OR claimed_at < now() - interval '60 seconds') ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 50) RETURNING id,type,payload,created_at,last_error", [nodeId]); await client.query("COMMIT"); return result.rows.map((row) => ({ id: row.id, type: row.type, payload: row.payload, createdAt: row.created_at.toISOString(), lastError: row.last_error || undefined })); } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); } }
function markResourceActive(type: string, payload: Record<string, unknown>) { const id = typeof payload.id === "string" ? payload.id : undefined; if (!id) return; if (type === "apply_tunnel") { const tunnel = db.tunnels.find((item) => item.id === id); if (tunnel) tunnel.status = "active"; } if (type === "apply_cdn") { const route = db.cdnRoutes.find((item) => item.id === id); if (route) route.status = "active"; } }
export async function acknowledgeCommandResults(nodeId: string, ids: string[], results: CommandResult[]): Promise<void> {
  const resultMap = new Map(results.map((result) => [result.id, result]));
  for (const id of ids) if (!resultMap.has(id)) resultMap.set(id, { id, ok: true });
  if (!resultMap.size) return;
  const normalizedResults = Array.from(resultMap.values());
  if (!pool) {
    const queue = db.commands.get(nodeId) ?? [];
    const remaining: Command[] = [];
    for (const command of queue) {
      const result = resultMap.get(command.id);
      if (!result || !result.ok) { if (result?.error) command.lastError = result.error; command.claimedAt = Date.now(); remaining.push(command); continue; }
      markResourceActive(command.type, command.payload);
    }
    db.commands.set(nodeId, remaining);
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const result of normalizedResults) {
      const id = result.id;
      if (result.ok) {
        const deleted = await client.query("DELETE FROM agent_commands WHERE node_id = $1 AND id = $2 RETURNING type,payload->>'id' AS resource_id,payload", [nodeId, id]);
        const deletedCommand = deleted.rows[0];
        const resourceId = typeof deletedCommand?.resource_id === "string" ? deletedCommand.resource_id : "";
        if (deletedCommand?.type === "apply_tunnel") {
          const activated = await client.query("UPDATE tunnels SET status = 'active' WHERE id = $1 AND node_id = $2 RETURNING id", [resourceId, nodeId]);
          if (!activated.rowCount) throw new Error(`tunnel command ${id} references missing resource ${resourceId}`);
        }
        if (deletedCommand?.type === "apply_cdn") {
          const activated = await client.query("UPDATE cdn_routes SET status = 'active' WHERE id = $1 AND (node_id IS NULL OR node_id = $2) RETURNING id", [resourceId, nodeId]);
          if (!activated.rowCount) throw new Error(`CDN command ${id} references missing resource ${resourceId}`);
        }
        if (deletedCommand?.type === "apply_tunnel" || deletedCommand?.type === "apply_cdn") {
          await client.query("INSERT INTO agent_resource_state (node_id,resource_type,resource_id,payload) VALUES ($1,$2,$3,$4) ON CONFLICT (node_id,resource_type,resource_id) DO UPDATE SET payload = EXCLUDED.payload, applied_at = now()", [nodeId, deletedCommand.type, resourceId, deletedCommand.payload]);
        }
        if (deletedCommand?.type === "remove_tunnel" || deletedCommand?.type === "remove_cdn") {
          await client.query("DELETE FROM agent_resource_state WHERE node_id = $1 AND resource_type = $2 AND resource_id = $3", [nodeId, deletedCommand.type === "remove_tunnel" ? "apply_tunnel" : "apply_cdn", resourceId]);
        }
      } else {
        await client.query("UPDATE agent_commands SET last_error = $3, claimed_at = now() WHERE node_id = $1 AND id = $2", [nodeId, id, result.error || "command_failed"]);
      }
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function findUserByEmail(email: string): Promise<import("./store").User | undefined> { if (!pool) return db.users.find((user) => user.email === email); const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]); return result.rows[0] ? { id: result.rows[0].id, email: result.rows[0].email, name: result.rows[0].name, passwordHash: result.rows[0].password_hash, createdAt: result.rows[0].created_at.toISOString() } : undefined; }
export async function findUserById(id: string): Promise<import("./store").User | undefined> { if (!pool) return db.users.find((user) => user.id === id); const result = await pool.query("SELECT * FROM users WHERE id = $1", [id]); return result.rows[0] ? { id: result.rows[0].id, email: result.rows[0].email, name: result.rows[0].name, passwordHash: result.rows[0].password_hash, createdAt: result.rows[0].created_at.toISOString() } : undefined; }
export async function insertUser(user: import("./store").User): Promise<import("./store").User> { if (!pool) { db.users.push(user); return user; } const result = await pool.query("INSERT INTO users (id,email,name,password_hash) VALUES ($1,$2,$3,$4) RETURNING *", [user.id, user.email, user.name, user.passwordHash]); return { ...user, createdAt: result.rows[0].created_at.toISOString() }; }
export async function saveSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void> { if (!pool) { db.sessions.set(tokenHash, { userId, expiresAt: expiresAt.getTime() }); return; } await pool.query("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)", [tokenHash, userId, expiresAt]); }
export async function findSession(tokenHash: string): Promise<string | undefined> { if (!pool) { const session = db.sessions.get(tokenHash); return session && session.expiresAt > Date.now() ? session.userId : undefined; } const result = await pool.query("SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()", [tokenHash]); return result.rows[0]?.user_id; }
export async function saveAdminSession(tokenHash: string, role: import("./store").AdminRole, expiresAt: Date): Promise<void> { if (!pool) { db.adminSessions.set(tokenHash, { role, expiresAt: expiresAt.getTime() }); return; } await pool.query("INSERT INTO admin_sessions (token_hash,role,expires_at) VALUES ($1,$2,$3)", [tokenHash, role, expiresAt]); }
export async function findAdminSession(tokenHash: string): Promise<import("./store").AdminRole | undefined> { if (!pool) { const session = db.adminSessions.get(tokenHash); return session && session.expiresAt > Date.now() ? session.role : undefined; } const result = await pool.query("SELECT role FROM admin_sessions WHERE token_hash = $1 AND expires_at > now()", [tokenHash]); return result.rows[0]?.role; }
export async function recordBillingEvent(eventId: string, provider: string, payload: Record<string, unknown>): Promise<boolean> { const event = { eventId, provider, payload, createdAt: new Date().toISOString() }; if (!pool) { if (db.billingEvents.has(eventId)) return false; db.billingEvents.set(eventId, event); return true; } const result = await pool.query("INSERT INTO billing_events (event_id,provider,payload) VALUES ($1,$2,$3) ON CONFLICT (event_id) DO NOTHING", [eventId, provider, payload]); return result.rowCount === 1; }
export async function chooseOnlineNode(capability: "cdn" | "frp"): Promise<Node | undefined> { return (await listAvailableNodes(capability))[0]; }
export async function insertOrder(order: import("./store").Order): Promise<import("./store").Order> { if (!pool) { db.orders.push(order); return order; } const result = await pool.query("INSERT INTO orders (id,user_id,plan_id,amount_cents,status) VALUES ($1,$2,$3,$4,$5) RETURNING *", [order.id, order.userId, order.planId, Math.round(order.amount * 100), order.status]); return { ...order, createdAt: result.rows[0].created_at.toISOString() }; }
export async function listOrders(userId: string): Promise<import("./store").Order[]> { if (!pool) return db.orders.filter((order) => order.userId === userId); const result = await pool.query("SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC", [userId]); return result.rows.map((row) => ({ id: row.id, userId: row.user_id, planId: row.plan_id, amount: Number(row.amount_cents) / 100, status: row.status, createdAt: row.created_at.toISOString() })); }
function mapOrder(row: any): import("./store").Order { return { id: row.id, userId: row.user_id, planId: row.plan_id, amount: Number(row.amount_cents) / 100, status: row.status, createdAt: row.created_at.toISOString() }; }
export async function listAllOrders(): Promise<import("./store").Order[]> { if (!pool) return [...db.orders].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)); const result = await pool.query("SELECT * FROM orders ORDER BY created_at DESC LIMIT 1000"); return result.rows.map(mapOrder); }
export async function listUsers(): Promise<import("./store").AdminUser[]> { if (!pool) return [...db.users].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(({ passwordHash: _passwordHash, ...user }) => user); const result = await pool.query("SELECT id,email,name,created_at FROM users ORDER BY created_at DESC LIMIT 1000"); return result.rows.map((row) => ({ id: row.id, email: row.email, name: row.name, createdAt: row.created_at.toISOString() })); }
export async function hasPaidPlan(userId: string, planId: string): Promise<boolean> { if (process.env.INFNET_ALLOW_UNPAID_DEV === "true") return true; if (!pool) return db.orders.some((order) => order.userId === userId && order.planId === planId && order.status === "paid"); const result = await pool.query("SELECT 1 FROM orders WHERE user_id = $1 AND plan_id = $2 AND status = 'paid' LIMIT 1", [userId, planId]); return result.rowCount === 1; }
export async function updateOrderStatus(orderId: string, status: import("./store").Order["status"]): Promise<boolean> {
  if (!pool) {
    const order = db.orders.find((item) => item.id === orderId);
    if (!order) return false;
    if (order.status === "pending") order.status = status;
    return true;
  }
  const result = await pool.query("UPDATE orders SET status = CASE WHEN status = 'pending' THEN $2 ELSE status END WHERE id = $1 RETURNING id", [orderId, status]);
  return result.rowCount === 1;
}
function addNodeAddress(tunnel: Tunnel): Tunnel { return { ...tunnel, nodeAddress: tunnel.nodeId ? db.nodes.find((node) => node.id === tunnel.nodeId)?.address : undefined }; }
export async function listUserTunnels(userId: string): Promise<Tunnel[]> { if (!pool) return db.tunnels.filter((tunnel) => tunnel.ownerId === userId).map(addNodeAddress); const result = await pool.query("SELECT t.*, n.address AS node_address FROM tunnels t LEFT JOIN nodes n ON n.id = t.node_id WHERE t.owner_id = $1 ORDER BY t.created_at DESC", [userId]); return result.rows.map(mapTunnel); }
export async function findUserTunnel(userId: string, id: string): Promise<Tunnel | undefined> { if (!pool) { const tunnel = db.tunnels.find((item) => item.ownerId === userId && item.id === id); return tunnel ? addNodeAddress(tunnel) : undefined; } const result = await pool.query("SELECT t.*, n.address AS node_address FROM tunnels t LEFT JOIN nodes n ON n.id = t.node_id WHERE t.owner_id = $1 AND t.id = $2", [userId, id]); return result.rows[0] ? mapTunnel(result.rows[0]) : undefined; }
export async function refreshUserTunnelTicket(userId: string, id: string): Promise<Tunnel | undefined> {
  const current = await findUserTunnel(userId, id);
  if (!current || current.status === "suspended" || current.status === "disabled") return current;
  const ticket = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  if (!pool) {
    const local = db.tunnels.find((item) => item.ownerId === userId && item.id === id);
    if (!local) return undefined;
    local.ticket = ticket;
    local.ticketExpiresAt = expiresAt;
    return addNodeAddress(local);
  }
  const result = await pool.query("UPDATE tunnels SET ticket = $3, ticket_expires_at = $4 WHERE owner_id = $1 AND id = $2 RETURNING *", [userId, id, ticket, expiresAt]);
  return result.rows[0] ? findUserTunnel(userId, id) : undefined;
}
export async function deleteUserTunnel(userId: string, id: string): Promise<Tunnel | undefined> { const tunnel = await findUserTunnel(userId, id); if (!tunnel) return undefined; if (!pool) { db.tunnels = db.tunnels.filter((item) => item.id !== id); return tunnel; } await pool.query("DELETE FROM tunnels WHERE owner_id = $1 AND id = $2", [userId, id]); return tunnel; }
export async function countUserTunnels(userId: string, planId: string): Promise<number> { if (!pool) return db.tunnels.filter((tunnel) => tunnel.ownerId === userId && tunnel.planId === planId).length; const result = await pool.query("SELECT count(*)::int AS count FROM tunnels WHERE owner_id = $1 AND plan_id = $2 AND status <> 'disabled'", [userId, planId]); return result.rows[0].count; }
function mapCdnRoute(row: any): import("./store").CdnRoute { return { id: row.id, hostname: row.hostname, origin: row.origin, cacheSeconds: row.cache_seconds, planId: row.plan_id, nodeId: row.node_id || undefined, ownerId: row.owner_id, status: row.status }; }
export async function listUserCdnRoutes(userId: string): Promise<import("./store").CdnRoute[]> { if (!pool) return db.cdnRoutes.filter((route) => route.ownerId === userId); const result = await pool.query("SELECT * FROM cdn_routes WHERE owner_id = $1 ORDER BY created_at DESC", [userId]); return result.rows.map(mapCdnRoute); }
export async function findUserCdnRoute(userId: string, id: string): Promise<import("./store").CdnRoute | undefined> { if (!pool) return db.cdnRoutes.find((route) => route.ownerId === userId && route.id === id); const result = await pool.query("SELECT * FROM cdn_routes WHERE owner_id = $1 AND id = $2", [userId, id]); return result.rows[0] ? mapCdnRoute(result.rows[0]) : undefined; }
export async function deleteUserCdnRoute(userId: string, id: string): Promise<import("./store").CdnRoute | undefined> { const route = await findUserCdnRoute(userId, id); if (!route) return undefined; if (!pool) { db.cdnRoutes = db.cdnRoutes.filter((item) => item.id !== id); return route; } await pool.query("DELETE FROM cdn_routes WHERE owner_id = $1 AND id = $2", [userId, id]); return route; }
export async function insertCdnRoute(route: import("./store").CdnRoute): Promise<import("./store").CdnRoute> { if (!pool) { db.cdnRoutes.push(route); return route; } const result = await pool.query("INSERT INTO cdn_routes (id,hostname,origin,cache_seconds,plan_id,node_id,owner_id,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *", [route.id, route.hostname, route.origin, route.cacheSeconds, route.planId, route.nodeId || null, route.ownerId, route.status]); return mapCdnRoute(result.rows[0]); }
export async function writeAudit(entry: Omit<import("./store").AuditLog, "id" | "createdAt">): Promise<void> { const audit = { ...entry, id: `audit_${crypto.randomUUID()}`, createdAt: new Date().toISOString() }; if (!pool) { db.audit.push(audit); return; } await pool.query("INSERT INTO audit_logs (id,actor_id,action,target_type,target_id,metadata) VALUES ($1,$2,$3,$4,$5,$6)", [audit.id, audit.actorId, audit.action, audit.targetType, audit.targetId || null, audit.metadata]); }
export async function listAudit(limit = 100): Promise<import("./store").AuditLog[]> { if (!pool) return db.audit.slice(-limit).reverse(); const result = await pool.query("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1", [Math.min(Math.max(limit, 1), 500)]); return result.rows.map((row) => ({ id: row.id, actorId: row.actor_id, action: row.action, targetType: row.target_type, targetId: row.target_id || undefined, metadata: row.metadata, createdAt: row.created_at.toISOString() })); }
