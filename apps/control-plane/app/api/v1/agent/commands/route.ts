import { NextResponse } from "next/server";
import { claimCommands } from "../../../../../lib/persistence";
import { requireAgent, validateAgentToken } from "../../../../../lib/auth";
export async function GET(req: Request) {
  const auth = requireAgent(req); if (auth.response) return auth.response;
  const nodeId = new URL(req.url).searchParams.get("nodeId"); if (!nodeId) return NextResponse.json({ error: "nodeId is required" }, { status: 400 });
  const denied = await validateAgentToken(auth.token, nodeId); if (denied) return denied;
  return NextResponse.json({ data: await claimCommands(nodeId) });
}
