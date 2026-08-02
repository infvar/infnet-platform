import { NextResponse } from "next/server";
import { findNode, recordUsage, reconcileReportedQuotas, reconcileSuspendedNodeQuotas, syncNodeDesiredState, updateNodeSeen } from "../../../../../lib/persistence";
import { requireAgent, validateAgentToken } from "../../../../../lib/auth";
export async function POST(req: Request) {
  const auth = requireAgent(req); if (auth.response) return auth.response;
  const body = await req.json(); const node = await findNode(body.nodeId || body.name);
  if (!node) return NextResponse.json({ error: "node_not_registered" }, { status: 404 });
  const denied = await validateAgentToken(auth.token, node.id); if (denied) return denied;
  const usage = Array.isArray(body.usage) ? body.usage : [];
  if (usage.some((item: any) => !item || typeof item.resourceId !== "string" || !["tunnel", "cdn"].includes(item.kind) || !Number.isSafeInteger(item.bytes) || item.bytes < 0)) return NextResponse.json({ error: "invalid_usage_report" }, { status: 400 });
  node.status = "online"; node.lastSeen = new Date().toISOString(); if (typeof body.address === "string" && body.address.trim()) node.address = body.address.trim(); await updateNodeSeen(node); await recordUsage(node.id, typeof body.usageReportId === "string" ? body.usageReportId : "", usage); await reconcileReportedQuotas(node.id, usage); await reconcileSuspendedNodeQuotas(node.id); await syncNodeDesiredState(node.id); return NextResponse.json({ ok: true, commands: [] });
}
