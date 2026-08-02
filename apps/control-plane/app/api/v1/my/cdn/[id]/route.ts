import { NextResponse } from "next/server";
import { cdnTargetNodes, deleteUserCdnRoute, enqueueCommand, writeAudit } from "../../../../../../lib/persistence";
import { requireUser } from "../../../../../../lib/user-auth";

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(req); if (auth.response) return auth.response;
  const { id } = await context.params;
  const route = await deleteUserCdnRoute(auth.userId, id);
  if (!route) return NextResponse.json({ error: "cdn_route_not_found" }, { status: 404 });
  const nodes = await cdnTargetNodes(route);
  for (const node of nodes) await enqueueCommand(node.id, { id: `cmd_${crypto.randomUUID()}`, type: "remove_cdn", payload: route as unknown as Record<string, unknown>, createdAt: new Date().toISOString() });
  await writeAudit({ actorId: auth.userId, action: "cdn.deleted", targetType: "cdn_route", targetId: route.id, metadata: { nodeIds: nodes.map((node) => node.id), hostname: route.hostname } });
  return NextResponse.json({ ok: true });
}
