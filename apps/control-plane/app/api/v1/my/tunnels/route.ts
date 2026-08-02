import { NextResponse } from "next/server";
import { chooseOnlineNode, countUserTunnels, enqueueCommand, findAvailableNode, hasPaidPlan, hasTrafficCapacity, insertUserTunnel, listPlans, listUserTunnels, tunnelPortInUse, writeAudit } from "../../../../../lib/persistence";
import { requireUser } from "../../../../../lib/user-auth";
export async function GET(req: Request) { const auth = await requireUser(req); if (auth.response) return auth.response; return NextResponse.json({ data: await listUserTunnels(auth.userId) }); }
export async function POST(req: Request) {
  const auth = await requireUser(req); if (auth.response) return auth.response;
  const body = await req.json();
  if (!body.name || !body.localAddr || !Number.isInteger(body.remotePort) || body.remotePort < 1024 || body.remotePort > 65535) return NextResponse.json({ error: "name, localAddr and remotePort are required" }, { status: 400 });
  const planId = String(body.planId || "starter");
  const plan = (await listPlans()).find((item) => item.id === planId);
  if (!plan) return NextResponse.json({ error: "plan_not_found" }, { status: 404 });
  if (!await hasPaidPlan(auth.userId, planId)) return NextResponse.json({ error: "paid_plan_required" }, { status: 402 });
  if (!await hasTrafficCapacity(auth.userId, planId)) return NextResponse.json({ error: "traffic_quota_exceeded" }, { status: 409 });
  if (plan.tunnels >= 0 && await countUserTunnels(auth.userId, planId) >= plan.tunnels) return NextResponse.json({ error: "tunnel_quota_exceeded" }, { status: 409 });
  const node = body.nodeId ? await findAvailableNode(String(body.nodeId), "frp") : await chooseOnlineNode("frp");
  if (!node) return NextResponse.json({ error: "node_unavailable" }, { status: 409 });
  if (await tunnelPortInUse(node.id, body.remotePort)) return NextResponse.json({ error: "remote_port_in_use" }, { status: 409 });
  const tunnel = { id: `tun_${crypto.randomUUID()}`, name: String(body.name), planId, nodeId: node.id, localAddr: String(body.localAddr), remotePort: body.remotePort, ticket: crypto.randomUUID(), ticketExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), status: "draft" as const, ownerId: auth.userId };
  try {
    const created = await insertUserTunnel(tunnel, plan.tunnels);
    if (!created) return NextResponse.json({ error: "tunnel_quota_exceeded" }, { status: 409 });
    await enqueueCommand(created.nodeId!, { id: `cmd_${crypto.randomUUID()}`, type: "apply_tunnel", payload: created as unknown as Record<string, unknown>, createdAt: new Date().toISOString() });
    await writeAudit({ actorId: auth.userId, action: "tunnel.created", targetType: "tunnel", targetId: created.id, metadata: { nodeId: created.nodeId, planId } });
    return NextResponse.json({ data: created }, { status: 201 });
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") return NextResponse.json({ error: "remote_port_in_use" }, { status: 409 });
    throw error;
  }
}
