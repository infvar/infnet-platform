import { NextResponse } from "next/server";
import { findNode, updateNodeMetadata, writeAudit } from "../../../../../lib/persistence";
import { requireAdmin, requireRole } from "../../../../../lib/auth";

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req); if ("response" in auth) return auth.response; const denied = requireRole(auth.role, ["owner", "operator"]); if (denied) return denied;
  const { id } = await context.params;
  const body = await req.json(); const current = await findNode(id); if (!current) return NextResponse.json({ error: "node_not_found" }, { status: 404 });
  const name = body.name === undefined ? current.name : String(body.name).trim(); const region = body.region === undefined ? current.region : String(body.region).trim(); const capabilities = body.capabilities === undefined ? current.capabilities : body.capabilities;
  if (!name || !region || !Array.isArray(capabilities) || capabilities.some((item: unknown) => item !== "cdn" && item !== "frp")) return NextResponse.json({ error: "valid node metadata required" }, { status: 400 });
  const updated = await updateNodeMetadata(id, { name, region, capabilities }); await writeAudit({ actorId: `admin:${auth.role}`, action: "node.updated", targetType: "node", targetId: id, metadata: { name, region, capabilities } }); return NextResponse.json({ data: updated });
}
