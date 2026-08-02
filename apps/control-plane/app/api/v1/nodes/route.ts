import { NextResponse } from "next/server";
import { insertNode, listNodes, writeAudit } from "../../../../lib/persistence";
import { requireAdmin, requireRole } from "../../../../lib/auth";
export async function GET(req: Request) { const auth = await requireAdmin(req); if ("response" in auth) return auth.response; return NextResponse.json({ data: await listNodes() }); }
export async function POST(req: Request) {
  const auth = await requireAdmin(req); if ("response" in auth) return auth.response; const denied = requireRole(auth.role, ["owner", "operator"]); if (denied) return denied;
  const body = await req.json(); if (!body.name || !body.region) return NextResponse.json({ error: "name and region are required" }, { status: 400 });
  const node = { id: `node_${crypto.randomUUID()}`, name: body.name, region: body.region, capabilities: body.capabilities ?? ["cdn", "frp"], status: "pending" as const };
  const token = crypto.randomUUID(); await insertNode(node, token); await writeAudit({ actorId: `admin:${auth.role}`, action: "node.created", targetType: "node", targetId: node.id, metadata: { name: node.name, region: node.region } });
  return NextResponse.json({ data: node, token }, { status: 201 });
}
