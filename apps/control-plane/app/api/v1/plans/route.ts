import { NextResponse } from "next/server";
import { insertPlan, listAllPlans, listPlans, writeAudit } from "../../../../lib/persistence";
import { requireAdmin, requireRole } from "../../../../lib/auth";

export async function GET(req: Request) { const wantsAll = new URL(req.url).searchParams.get("all") === "true"; if (!wantsAll) return NextResponse.json({ data: await listPlans() }); const auth = await requireAdmin(req); if ("response" in auth) return auth.response; return NextResponse.json({ data: await listAllPlans() }); }
export async function POST(req: Request) {
  const auth = await requireAdmin(req); if ("response" in auth) return auth.response; const denied = requireRole(auth.role, ["owner", "operator"]); if (denied) return denied;
  const body = await req.json();
  if (!body.name || !Number.isFinite(body.price)) return NextResponse.json({ error: "name and price are required" }, { status: 400 });
  const plan = { id: `plan_${crypto.randomUUID()}`, name: String(body.name), price: Number(body.price), tunnels: Number(body.tunnels ?? 1), trafficGb: Number(body.trafficGb ?? 10), enabled: true };
  const created = await insertPlan(plan); await writeAudit({ actorId: `admin:${auth.role}`, action: "plan.created", targetType: "plan", targetId: created.id, metadata: { name: created.name } }); return NextResponse.json({ data: created }, { status: 201 });
}
