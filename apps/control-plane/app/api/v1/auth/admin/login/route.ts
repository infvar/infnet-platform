import { NextResponse } from "next/server";
import { adminSessionResponse, configuredAdminRole } from "../../../../../../lib/auth";
import { allowRequest } from "../../../../../../lib/rate-limit";
export async function POST(req: Request) {
  const address = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!await allowRequest(`admin-login:${address}`, 10, 300000)) return NextResponse.json({ error: "too_many_attempts" }, { status: 429 });
  const body = await req.json(); const provided = String(body.token || ""); const role = configuredAdminRole(provided); if (!role) return NextResponse.json({ error: "invalid_credentials" }, { status: 401 }); return adminSessionResponse(role);
}
