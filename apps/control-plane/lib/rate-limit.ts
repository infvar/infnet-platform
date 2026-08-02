const buckets = new Map<string, { count: number; resetAt: number }>();

// Upstash Redis REST keeps rate limiting available in Edge functions. Local
// development falls back to an in-process bucket when the REST credentials are absent.
export async function checkRedis() {
  const configured = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
  if (!configured) return { configured: false, ok: true };
  try { const response = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/ping`, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }); return { configured: true, ok: response.ok }; } catch { return { configured: true, ok: false }; }
}

export async function allowRequest(key: string, max: number, windowMs: number) {
  const url = process.env.UPSTASH_REDIS_REST_URL; const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    try {
      const redisKey = `infnet:ratelimit:${key}`;
      const response = await fetch(`${url}/pipeline`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify([["INCR", redisKey], ["PEXPIRE", redisKey, String(windowMs)]]) });
      if (response.ok) { const result = await response.json() as Array<{ result?: number }>; return Number(result[0]?.result || 0) <= max; }
    } catch { /* fall through to the local limiter */ }
  }
  const now = Date.now(); const current = buckets.get(key);
  if (!current || current.resetAt <= now) { buckets.set(key, { count: 1, resetAt: now + windowMs }); return true; }
  if (current.count >= max) return false; current.count += 1; return true;
}
