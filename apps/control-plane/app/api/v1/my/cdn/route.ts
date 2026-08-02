import { NextResponse } from "next/server";
import { enqueueCommand, findAvailableNode, hasPaidPlan, hasTrafficCapacity, insertCdnRoute, listAvailableNodes, listUserCdnRoutes, writeAudit } from "../../../../../lib/persistence";
import { requireUser } from "../../../../../lib/user-auth";

export async function GET(req: Request) {
  const auth = await requireUser(req); if (auth.response) return auth.response;
  return NextResponse.json({ data: await listUserCdnRoutes(auth.userId) });
}

export async function POST(req: Request) {
  const auth = await requireUser(req); if (auth.response) return auth.response;
  const body = await req.json();
  const planId = String(body.planId || "starter");
  if (!await hasPaidPlan(auth.userId, planId)) return NextResponse.json({ error: "paid_plan_required" }, { status: 402 });
  if (!await hasTrafficCapacity(auth.userId, planId)) return NextResponse.json({ error: "traffic_quota_exceeded" }, { status: 409 });
  let origin: URL;
  try {
    origin = new URL(String(body.origin));
    const host = origin.hostname.toLowerCase();
    const privateIpv4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host);
    const privateIpv6 = host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
    if (!["http:", "https:"].includes(origin.protocol) || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || privateIpv4 || privateIpv6) throw new Error();
  } catch { return NextResponse.json({ error: "public_http_origin_required" }, { status: 400 }); }
  const hostname = String(body.hostname || "").toLowerCase();
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) return NextResponse.json({ error: "valid_hostname_required" }, { status: 400 });
  const nodes = body.nodeId ? [await findAvailableNode(String(body.nodeId), "cdn")] : await listAvailableNodes("cdn");
  if (!nodes.length || nodes.some((node) => !node)) return NextResponse.json({ error: "node_unavailable" }, { status: 409 });
  const cacheSeconds = Number(body.cacheSeconds ?? 60);
  if (!Number.isInteger(cacheSeconds) || cacheSeconds < 0 || cacheSeconds > 86400) return NextResponse.json({ error: "valid_cache_seconds_required" }, { status: 400 });
  // A missing nodeId means replicate this route to every CDN node. Keep an
  // explicit node selection distinct so desired-state sync can preserve it.
  const route = { id: `cdn_${crypto.randomUUID()}`, hostname, origin: origin.toString().replace(/\/$/, ""), cacheSeconds, planId, nodeId: body.nodeId ? nodes[0]!.id : undefined, ownerId: auth.userId, status: "draft" as const };
  const created = await insertCdnRoute(route);
  for (const node of nodes) await enqueueCommand(node!.id, { id: `cmd_${crypto.randomUUID()}`, type: "apply_cdn", payload: created as unknown as Record<string, unknown>, createdAt: new Date().toISOString() });
  await writeAudit({ actorId: auth.userId, action: "cdn.created", targetType: "cdn_route", targetId: created.id, metadata: { nodeIds: nodes.map((node) => node!.id), hostname } });
  return NextResponse.json({ data: created, replicatedTo: nodes.length }, { status: 201 });
}
