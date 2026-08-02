import { NextResponse } from "next/server";
import { registerUser, sessionResponse } from "../../../../../lib/user-auth";
import { allowRequest } from "../../../../../lib/rate-limit";
import { writeAudit } from "../../../../../lib/persistence";
export async function POST(req: Request) { try { const body = await req.json(); const email = String(body.email || "").toLowerCase(); if (!await allowRequest(`register:${email}`, 5, 3600000)) return NextResponse.json({ error: "too_many_attempts" }, { status: 429 }); const result = await registerUser(email, String(body.password || ""), String(body.name || "")); await writeAudit({ actorId: result.user.id, action: "auth.register", targetType: "user", targetId: result.user.id, metadata: {} }); return sessionResponse({ user: result.user }, result.token, 201); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "registration_failed" }, { status: 400 }); } }
