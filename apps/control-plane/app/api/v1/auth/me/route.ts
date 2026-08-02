import { NextResponse } from "next/server";
import { currentUser } from "../../../../../lib/user-auth";
export async function GET(req: Request) { const result = await currentUser(req); if ("response" in result) return result.response; return NextResponse.json({ user: result.user }); }
