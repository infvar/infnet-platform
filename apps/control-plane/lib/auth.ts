import { NextResponse } from "next/server";
import { findAdminSession, saveAdminSession, validateNodeToken } from "./persistence";
import { AdminRole } from "./store";
import { randomToken, sameSecret, sha256 } from "./edge-crypto";

function requestToken(req: Request) {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const cookie = req.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith("infnet_admin_session="))?.slice("infnet_admin_session=".length);
  return { bearer, cookie, token: bearer === "cookie" ? cookie : bearer || cookie };
}
export function configuredAdminRole(token: string | undefined): AdminRole | undefined { if (sameSecret(token, process.env.INFNET_ADMIN_TOKEN || "")) return "owner"; if (sameSecret(token, process.env.INFNET_ADMIN_OPERATOR_TOKEN || "")) return "operator"; if (sameSecret(token, process.env.INFNET_ADMIN_VIEWER_TOKEN || "")) return "viewer"; }

export async function requireAdmin(req: Request): Promise<{ role: AdminRole } | { response: NextResponse }> {
  const { token } = requestToken(req);
  const configuredRole = configuredAdminRole(token);
  if (configuredRole) return { role: configuredRole };
  if (!token) return { response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const role = await findAdminSession(await sha256(token));
  if (!role) return { response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  return { role };
}

export function requireRole(role: AdminRole, allowed: AdminRole[]) { return allowed.includes(role) ? null : NextResponse.json({ error: "forbidden" }, { status: 403 }); }

export async function adminSessionResponse(role: AdminRole = "owner") {
  const token = randomToken();
  await saveAdminSession(await sha256(token), role, new Date(Date.now() + 86400000));
  const response = NextResponse.json({ ok: true });
  response.cookies.set("infnet_admin_session", token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 86400 });
  return response;
}
export function clearAdminSessionResponse() { const response = NextResponse.json({ ok: true }); response.cookies.set("infnet_admin_session", "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 }); return response; }

export function requireAgent(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return { response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  return { token };
}

export async function validateAgentToken(token: string, nodeId: string) {
  if (!await validateNodeToken(nodeId, token)) return NextResponse.json({ error: "invalid_node_token" }, { status: 401 });
  return null;
}
