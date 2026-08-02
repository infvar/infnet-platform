import { NextResponse } from "next/server";
import { findSession, findUserByEmail, findUserById, insertUser, saveSession } from "./persistence";
import { User } from "./store";
import { pbkdf2Hash, pbkdf2Verify, randomId, randomToken, sha256 } from "./edge-crypto";

const sessionDays = 7;
export const hashPassword = pbkdf2Hash;
export const verifyPassword = pbkdf2Verify;
export async function tokenHash(token: string) { return sha256(token); }
function cookieToken(req: Request) { const cookie = req.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith("infnet_session=")); return cookie?.slice("infnet_session=".length); }
export async function createSession(userId: string) { const token = randomToken(); await saveSession(await tokenHash(token), userId, new Date(Date.now() + sessionDays * 86400000)); return token; }
export async function requireUser(req: Request) { const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || cookieToken(req); if (!token) return { response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) }; const userId = await findSession(await tokenHash(token)); if (!userId) return { response: NextResponse.json({ error: "session_expired" }, { status: 401 }) }; return { userId }; }
export async function currentUser(req: Request) { const auth = await requireUser(req); if (auth.response) return auth; const user = await findUserById(auth.userId); if (!user) return { response: NextResponse.json({ error: "user_not_found" }, { status: 404 }) }; return { user: { id: user.id, email: user.email, name: user.name } }; }
export function sessionResponse(body: unknown, token: string, status = 200) { const response = NextResponse.json(body, { status }); response.cookies.set("infnet_session", token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: sessionDays * 86400 }); return response; }
export function clearSessionResponse() { const response = NextResponse.json({ ok: true }); response.cookies.set("infnet_session", "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 }); return response; }
export async function registerUser(email: string, password: string, name: string): Promise<{ user: Omit<User, "passwordHash">; token: string }> { if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 10) throw new Error("valid email and password of at least 10 characters are required"); if (await findUserByEmail(email)) throw new Error("email_already_registered"); const user = { id: `usr_${randomId()}`, email: email.toLowerCase(), name: name || email.split("@")[0], passwordHash: await hashPassword(password), createdAt: new Date().toISOString() }; await insertUser(user); const { passwordHash: _passwordHash, ...publicUser } = user; return { user: publicUser, token: await createSession(user.id) }; }
