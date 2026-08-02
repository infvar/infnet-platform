import { NextResponse } from "next/server";
import { createSession, sessionResponse, verifyPassword } from "../../../../../lib/user-auth";
import { findUserByEmail } from "../../../../../lib/persistence";
import { allowRequest } from "../../../../../lib/rate-limit";
import { writeAudit } from "../../../../../lib/persistence";
export async function POST(req: Request) { const body = await req.json(); const email = String(body.email || "").toLowerCase(); if (!await allowRequest(`login:${email}`, 10, 300000)) return NextResponse.json({ error: "too_many_attempts" }, { status: 429 }); const user = await findUserByEmail(email); if (!user || !(await verifyPassword(String(body.password || ""), user.passwordHash))) return NextResponse.json({ error: "invalid_credentials" }, { status: 401 }); await writeAudit({ actorId: user.id, action: "auth.login", targetType: "user", targetId: user.id, metadata: {} }); const token = await createSession(user.id); return sessionResponse({ user: { id: user.id, email: user.email, name: user.name } }, token); }
