import { NextResponse } from "next/server";
import { findNode, rotateNodeToken, writeAudit } from "../../../../../../lib/persistence";
import { requireAdmin, requireRole } from "../../../../../../lib/auth";
import { randomToken } from "../../../../../../lib/edge-crypto";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req); if ("response" in auth) return auth.response; const denied = requireRole(auth.role, ["owner", "operator"]); if (denied) return denied;
  const { id } = await context.params;
  const node = await findNode(id); if (!node) return NextResponse.json({ error: "node_not_found" }, { status: 404 });
  const token = randomToken(); if (!await rotateNodeToken(node.id, token)) return NextResponse.json({ error: "token_rotation_failed" }, { status: 500 });
  await writeAudit({ actorId: `admin:${auth.role}`, action: "node.token_rotated", targetType: "node", targetId: node.id, metadata: {} }); return NextResponse.json({ nodeId: node.id, token });
}
