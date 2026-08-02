import { NextResponse } from "next/server";
import { listAudit } from "../../../../lib/persistence";
import { requireAdmin } from "../../../../lib/auth";
export async function GET(req: Request) { const auth = await requireAdmin(req); if ("response" in auth) return auth.response; const limit = Number(new URL(req.url).searchParams.get("limit") || 100); return NextResponse.json({ data: await listAudit(limit) }); }
