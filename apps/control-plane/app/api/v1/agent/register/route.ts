import { NextResponse } from "next/server";
import { insertNode, findNode, syncNodeDesiredState, updateNodeSeen } from "../../../../../lib/persistence";
import { requireAgent, validateAgentToken } from "../../../../../lib/auth";
import { randomId, randomToken, sameSecret } from "../../../../../lib/edge-crypto";
export async function POST(req: Request) {
  const auth = requireAgent(req); if (auth.response) return auth.response;
  const body = await req.json(); const input = body.node ?? {}; let issuedToken: string | undefined;
  let node = await findNode(input.id || input.name);
  if (node) {
    const denied = await validateAgentToken(auth.token, node.id); if (denied) return denied;
  } else {
    const bootstrap = process.env.INFNET_NODE_BOOTSTRAP_TOKEN;
    if (!bootstrap || !sameSecret(auth.token, bootstrap)) return NextResponse.json({ error: "node_not_provisioned" }, { status: 403 });
    issuedToken = randomToken();
    node = { id: input.id || `node_${randomId()}`, name: input.name || "edge-node", region: input.region || "unknown", capabilities: input.capabilities || ["cdn", "frp"], status: "online" }; await insertNode(node, issuedToken);
  }
  node.status = "online"; node.lastSeen = new Date().toISOString(); node.address = body.address; await updateNodeSeen(node); await syncNodeDesiredState(node.id);
  return NextResponse.json({ ok: true, nodeId: node.id, nodeToken: issuedToken, pollAfter: 20, configVersion: "1" });
}
