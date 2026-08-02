import { NextResponse } from "next/server";
import { findPlan, updatePlan, writeAudit } from "../../../../../lib/persistence";
import { requireAdmin, requireRole } from "../../../../../lib/auth";

function validatePatch(body: any) {
  if (body.name !== undefined && (!String(body.name).trim() || String(body.name).length > 80)) return "valid name required";
  if (body.price !== undefined && (!Number.isFinite(body.price) || body.price < 0)) return "valid price required";
  if (body.tunnels !== undefined && (!Number.isInteger(body.tunnels) || body.tunnels < -1)) return "valid tunnels quota required";
  if (body.trafficGb !== undefined && (!Number.isInteger(body.trafficGb) || body.trafficGb < 1)) return "valid traffic quota required";
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") return "enabled must be boolean";
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req); if ("response" in auth) return auth.response; const denied = requireRole(auth.role, ["owner", "operator"]); if (denied) return denied;
  const { id } = await context.params;
  const body = await req.json(); const error = validatePatch(body); if (error) return NextResponse.json({ error }, { status: 400 });
  const current = await findPlan(id); if (!current) return NextResponse.json({ error: "plan_not_found" }, { status: 404 });
  const updated = await updatePlan(id, { name: body.name === undefined ? current.name : String(body.name).trim(), price: body.price === undefined ? current.price : Number(body.price), tunnels: body.tunnels === undefined ? current.tunnels : Number(body.tunnels), trafficGb: body.trafficGb === undefined ? current.trafficGb : Number(body.trafficGb), enabled: body.enabled === undefined ? current.enabled : body.enabled });
  await writeAudit({ actorId: `admin:${auth.role}`, action: "plan.updated", targetType: "plan", targetId: id, metadata: body }); return NextResponse.json({ data: updated });
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req); if ("response" in auth) return auth.response; const denied = requireRole(auth.role, ["owner", "operator"]); if (denied) return denied;
  const { id } = await context.params;
  const updated = await updatePlan(id, { enabled: false }); if (!updated) return NextResponse.json({ error: "plan_not_found" }, { status: 404 });
  await writeAudit({ actorId: `admin:${auth.role}`, action: "plan.disabled", targetType: "plan", targetId: updated.id, metadata: {} }); return NextResponse.json({ data: updated });
}
