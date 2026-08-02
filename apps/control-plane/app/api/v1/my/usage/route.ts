import { NextResponse } from "next/server";
import { listUserUsage } from "../../../../../lib/persistence";
import { requireUser } from "../../../../../lib/user-auth";

export async function GET(req: Request) {
  const auth = await requireUser(req); if (auth.response) return auth.response;
  return NextResponse.json({ data: await listUserUsage(auth.userId) });
}
