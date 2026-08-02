import { NextResponse } from "next/server";
import { pool } from "../../../lib/persistence";
import { checkRedis } from "../../../lib/rate-limit";

export async function GET() {
  const checks: Record<string, string> = {};
  let healthy = true;
  if (pool) {
    try { await pool.query("SELECT 1"); checks.postgres = "ok"; }
    catch { checks.postgres = "error"; healthy = false; }
  } else checks.postgres = "not_configured";
  const redis = await checkRedis();
  checks.redis = redis.configured ? (redis.ok ? "ok" : "error") : "not_configured";
  if (redis.configured && !redis.ok) healthy = false;
  const production = process.env.NODE_ENV === "production";
  if (production && (!pool || !redis.configured)) healthy = false;
  const paymentProvider = process.env.INFNET_PAYMENT_PROVIDER || "webhook";
  const paymentConfigured = paymentProvider === "stripe"
    ? Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET && process.env.INFNET_PUBLIC_URL)
    : Boolean(process.env.INFNET_PAYMENT_WEBHOOK_SECRET);
  checks.payment = paymentConfigured ? paymentProvider : "not_configured";
  if (production && (!paymentConfigured || process.env.INFNET_ALLOW_UNPAID_DEV === "true")) healthy = false;
  return NextResponse.json({ ok: healthy, service: "infnet-control-plane", version: "0.1.0", checks, time: new Date().toISOString() }, { status: healthy ? 200 : 503 });
}
