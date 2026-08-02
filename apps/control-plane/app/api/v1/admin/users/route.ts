import { NextResponse } from "next/server";
import { listUsers } from "../../../../../lib/persistence";
import { requireAdmin } from "../../../../../lib/auth";

export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response;
  return NextResponse.json({ data: await listUsers() });
}
