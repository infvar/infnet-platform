import { NextResponse } from "next/server";
import { deleteUserTunnel, enqueueCommand, findUserTunnel, refreshUserTunnelTicket, writeAudit } from "../../../../../../lib/persistence";
import { requireUser } from "../../../../../../lib/user-auth";

function shellQuote(value: string) { return `'${value.replace(/'/g, "'\\''")}'`; }

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(req); if (auth.response) return auth.response;
  const { id } = await context.params;
  let tunnel = await findUserTunnel(auth.userId, id);
  if (!tunnel) return NextResponse.json({ error: "tunnel_not_found" }, { status: 404 });
  if (tunnel.status === "suspended" || tunnel.status === "disabled") return NextResponse.json({ error: "tunnel_suspended" }, { status: 409 });
  if (!tunnel.nodeAddress) return NextResponse.json({ error: "node_public_address_unavailable" }, { status: 409 });
  if (Date.parse(tunnel.ticketExpiresAt) <= Date.now() + 5 * 60 * 1000) {
    tunnel = await refreshUserTunnelTicket(auth.userId, tunnel.id);
    if (!tunnel || !tunnel.nodeAddress) return NextResponse.json({ error: "tunnel_refresh_failed" }, { status: 503 });
    if (tunnel.nodeId) await enqueueCommand(tunnel.nodeId, { id: `cmd_${crypto.randomUUID()}`, type: "apply_tunnel", payload: tunnel as unknown as Record<string, unknown>, createdAt: new Date().toISOString() });
  }
  const command = `infnet-client -server ${shellQuote(tunnel.nodeAddress)} -ticket ${shellQuote(tunnel.ticket)} -name ${shellQuote(tunnel.name)} -local ${shellQuote(tunnel.localAddr)}`;
  return NextResponse.json({ data: { server: tunnel.nodeAddress, ticket: tunnel.ticket, name: tunnel.name, localAddr: tunnel.localAddr, command } });
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(req); if (auth.response) return auth.response;
  const { id } = await context.params;
  const tunnel = await deleteUserTunnel(auth.userId, id);
  if (!tunnel) return NextResponse.json({ error: "tunnel_not_found" }, { status: 404 });
  if (tunnel.nodeId) await enqueueCommand(tunnel.nodeId, { id: `cmd_${crypto.randomUUID()}`, type: "remove_tunnel", payload: tunnel as unknown as Record<string, unknown>, createdAt: new Date().toISOString() });
  await writeAudit({ actorId: auth.userId, action: "tunnel.deleted", targetType: "tunnel", targetId: tunnel.id, metadata: { nodeId: tunnel.nodeId } });
  return NextResponse.json({ ok: true });
}
