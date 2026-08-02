import { NextResponse } from "next/server";
import { chooseOnlineNode, enqueueCommand, findAvailableNode, insertTunnel, listTunnels, tunnelPortInUse } from "../../../../lib/persistence";
import { requireAdmin, requireRole } from "../../../../lib/auth";
export async function GET(req: Request) { const auth = await requireAdmin(req); if ("response" in auth) return auth.response; const tunnels = await listTunnels(); return NextResponse.json({ data: tunnels.map(({ ticket: _ticket, ...tunnel }) => tunnel) }); }
export async function POST(req: Request) {
  const auth = await requireAdmin(req); if ("response" in auth) return auth.response; const denied = requireRole(auth.role, ["owner", "operator"]); if (denied) return denied;
  const body = await req.json();
  if (!body.name || !body.localAddr || !Number.isInteger(body.remotePort) || body.remotePort < 1024 || body.remotePort > 65535) return NextResponse.json({ error: "name, localAddr and remotePort are required" }, { status: 400 });
  const node = body.nodeId ? await findAvailableNode(String(body.nodeId), "frp") : await chooseOnlineNode("frp");
  if (!node) return NextResponse.json({ error: "node_unavailable" }, { status: 409 });
  if (await tunnelPortInUse(node.id, body.remotePort)) return NextResponse.json({ error: "remote_port_in_use" }, { status: 409 });
  const tunnel = { id: `tun_${crypto.randomUUID()}`, name: String(body.name), planId: String(body.planId ?? "starter"), nodeId: node.id, localAddr: String(body.localAddr), remotePort: body.remotePort, ticket: crypto.randomUUID(), ticketExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), status: "draft" as const, ownerId: "admin" };
  try {
    const created = await insertTunnel(tunnel);
    await enqueueCommand(created.nodeId!, { id: `cmd_${crypto.randomUUID()}`, type: "apply_tunnel", payload: created as unknown as Record<string, unknown>, createdAt: new Date().toISOString() });
    return NextResponse.json({ data: created }, { status: 201 });
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") return NextResponse.json({ error: "remote_port_in_use" }, { status: 409 });
    throw error;
  }
}
