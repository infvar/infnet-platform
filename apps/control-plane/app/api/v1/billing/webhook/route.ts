import { NextResponse } from "next/server";
import { recordBillingEvent, updateOrderStatus, writeAudit } from "../../../../../lib/persistence";
import { verifyStripeSignature } from "../../../../../lib/payment";
import { hmacSha256Hex, sameSecret, sha256 } from "../../../../../lib/edge-crypto";

async function validHmac(raw: string, signature: string, secret: string) {
  const expected = `sha256=${await hmacSha256Hex(raw, secret)}`;
  return sameSecret(signature, expected);
}

export async function POST(req: Request) {
  const raw = await req.text();
  const configuredProvider = process.env.INFNET_PAYMENT_PROVIDER || "webhook";
  let body: any;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  let eventId: string; let provider: string; let orderId: string | undefined; let status: "paid" | "cancelled" | "pending";
  if (configuredProvider === "stripe") {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return NextResponse.json({ error: "stripe_webhook_not_configured" }, { status: 503 });
    if (!await verifyStripeSignature(raw, req.headers.get("stripe-signature") || "", secret)) return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
    eventId = String(body.id || await sha256(raw)); provider = "stripe";
    const session = body.data?.object || {}; orderId = String(session.metadata?.orderId || session.client_reference_id || "");
    status = body.type === "checkout.session.completed" && session.payment_status === "paid" ? "paid" : "pending";
  } else {
    const secret = process.env.INFNET_PAYMENT_WEBHOOK_SECRET;
    if (!secret) return NextResponse.json({ error: "payment_webhook_not_configured" }, { status: 503 });
    if (!await validHmac(raw, req.headers.get("x-infnet-signature") || "", secret)) return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
    eventId = String(body.eventId || await sha256(raw)); provider = String(body.provider || "webhook"); orderId = body.orderId ? String(body.orderId) : undefined;
    status = body.status === "paid" ? "paid" : body.status === "cancelled" ? "cancelled" : "pending";
  }
  if (!orderId || !(await updateOrderStatus(orderId, status))) return NextResponse.json({ error: "order_not_found" }, { status: 404 });
  if (!await recordBillingEvent(eventId, provider, body)) return NextResponse.json({ ok: true, duplicate: true });
  await writeAudit({ actorId: `payment:${provider}`, action: `order.${status}`, targetType: "order", targetId: orderId, metadata: { eventId } });
  return NextResponse.json({ ok: true });
}
