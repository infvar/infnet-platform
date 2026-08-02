import { Order, Plan } from "./store";
import { hmacSha256Hex, sameSecret } from "./edge-crypto";

export type Checkout = { provider: "webhook" | "stripe"; url?: string };

export async function createCheckout(order: Order, plan: Plan): Promise<Checkout> {
  const provider = process.env.INFNET_PAYMENT_PROVIDER || "webhook";
  if (provider !== "stripe") return { provider: "webhook" };
  const secret = process.env.STRIPE_SECRET_KEY;
  const publicUrl = process.env.INFNET_PUBLIC_URL;
  if (!secret || !publicUrl) throw new Error("stripe_checkout_not_configured");
  const base = publicUrl.replace(/\/$/, "");
  const form = new URLSearchParams({
    mode: "payment",
    success_url: `${base}/customer?payment=success`,
    cancel_url: `${base}/customer?payment=cancelled`,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "cny",
    "line_items[0][price_data][unit_amount]": String(Math.round(order.amount * 100)),
    "line_items[0][price_data][product_data][name]": `infNet ${plan.name}`,
    "metadata[orderId]": order.id,
    client_reference_id: order.id,
  });
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/x-www-form-urlencoded" }, body: form });
  if (!response.ok) throw new Error(`stripe_checkout_failed_${response.status}`);
  const body = await response.json() as { url?: string };
  if (!body.url) throw new Error("stripe_checkout_url_missing");
  return { provider: "stripe", url: body.url };
}

export async function verifyStripeSignature(raw: string, signature: string, secret: string): Promise<boolean> {
  const parts = new Map(signature.split(",").map((item) => item.split("=", 2) as [string, string]));
  const timestamp = parts.get("t"); const provided = parts.get("v1");
  if (!timestamp || !provided || !Number.isFinite(Number(timestamp)) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = await hmacSha256Hex(`${timestamp}.${raw}`, secret);
  return sameSecret(provided, expected);
}
