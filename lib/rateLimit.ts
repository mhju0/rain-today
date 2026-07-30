import { createHash } from "node:crypto";

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitInput {
  scope: string;
  identifier: string;
  limit: number;
  windowMs: number;
  now?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

/** In-process fallback limiter. Production should additionally enforce limits at the edge. */
export function consumeRateLimit({
  scope,
  identifier,
  limit,
  windowMs,
  now = Date.now(),
}: RateLimitInput): RateLimitResult {
  const key = `${scope}:${identifier}`;
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
  }
  bucket.count += 1;
  buckets.delete(key);
  buckets.set(key, bucket);
  pruneBuckets(now);

  const allowed = bucket.count <= limit;
  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

function pruneBuckets(now: number): void {
  if (buckets.size <= MAX_BUCKETS) return;
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
  while (buckets.size > MAX_BUCKETS) {
    const oldest = buckets.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
}

function clientIdentifier(request: Request): string {
  const forwarded =
    request.headers.get("x-vercel-forwarded-for") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for") ??
    "anonymous";
  const address = forwarded.split(",", 1)[0].trim().slice(0, 128);
  return createHash("sha256").update(address).digest("base64url").slice(0, 22);
}

export function enforceRequestRateLimit(
  request: Request,
  scope: string,
  { limit, windowMs }: { limit: number; windowMs: number },
): Response | null {
  const result = consumeRateLimit({
    scope,
    identifier: clientIdentifier(request),
    limit,
    windowMs,
  });
  if (result.allowed) return null;
  return new Response("too many requests", {
    status: 429,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": String(result.retryAfterSeconds),
      "X-RateLimit-Limit": String(result.limit),
      "X-RateLimit-Remaining": "0",
    },
  });
}

export function clearRateLimits(): void {
  buckets.clear();
}
