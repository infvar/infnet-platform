export type Plan = { id: string; name: string; price: number; tunnels: number; trafficGb: number; enabled: boolean };
export type Node = { id: string; name: string; region: string; capabilities: string[]; status: "online" | "offline" | "pending"; lastSeen?: string; address?: string };
export type Tunnel = { id: string; name: string; planId: string; nodeId?: string; nodeAddress?: string; localAddr: string; remotePort: number; ticket: string; ticketExpiresAt: string; status: "draft" | "active" | "disabled" | "suspended"; ownerId: string };
export type Command = { id: string; type: string; payload: Record<string, unknown>; createdAt: string; lastError?: string; claimedAt?: number };
export type CommandResult = { id: string; ok: boolean; error?: string };
export type User = { id: string; email: string; name: string; passwordHash: string; createdAt: string };
export type AdminUser = { id: string; email: string; name: string; createdAt: string };
export type Order = { id: string; userId: string; planId: string; amount: number; status: "pending" | "paid" | "cancelled"; createdAt: string };
export type CdnRoute = { id: string; hostname: string; origin: string; cacheSeconds: number; planId: string; nodeId?: string; ownerId: string; status: "draft" | "active" | "suspended" };
export type UsageRecord = { period: string; nodeId: string; ownerId: string; planId: string; resourceId: string; kind: "tunnel" | "cdn"; bytes: number };
export type UsageSummary = { planId: string; bytes: number; trafficGb: number; overQuota: boolean };
export type AuditLog = { id: string; actorId: string; action: string; targetType: string; targetId?: string; metadata: Record<string, unknown>; createdAt: string };
export type AdminRole = "owner" | "operator" | "viewer";
export type BillingEvent = { eventId: string; provider: string; payload: Record<string, unknown>; createdAt: string };

const state = globalThis as typeof globalThis & { __infnet?: { plans: Plan[]; nodes: Node[]; tunnels: Tunnel[]; commands: Map<string, Command[]>; nodeTokens: Map<string, string>; users: User[]; sessions: Map<string, { userId: string; expiresAt: number }>; adminSessions: Map<string, { role: AdminRole; expiresAt: number }>; orders: Order[]; cdnRoutes: CdnRoute[]; usage: UsageRecord[]; audit: AuditLog[]; billingEvents: Map<string, BillingEvent>; usageReports: Set<string> } };
if (!state.__infnet) state.__infnet = {
  plans: [
    { id: "starter", name: "Starter", price: 19, tunnels: 3, trafficGb: 100, enabled: true },
    { id: "growth", name: "Growth", price: 69, tunnels: 15, trafficGb: 1024, enabled: true },
    { id: "scale", name: "Scale", price: 199, tunnels: -1, trafficGb: 5120, enabled: true },
  ],
  nodes: [], tunnels: [], commands: new Map(), nodeTokens: new Map(), users: [], sessions: new Map(), adminSessions: new Map(), orders: [], cdnRoutes: [], usage: [], audit: [], billingEvents: new Map(), usageReports: new Set(),
};
export const db = state.__infnet;

export function issueCommand(nodeId: string, type: string, payload: Record<string, unknown>) {
  const command = { id: `cmd_${crypto.randomUUID()}`, type, payload, createdAt: new Date().toISOString() };
  const queue = db.commands.get(nodeId) ?? [];
  queue.push(command); db.commands.set(nodeId, queue); return command;
}
