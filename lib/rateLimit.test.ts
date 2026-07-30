import assert from "node:assert/strict";
import test from "node:test";
import { clearRateLimits, consumeRateLimit } from "./rateLimit.ts";

test("consumeRateLimit denies excess requests and resets after the window", () => {
  clearRateLimits();
  const input = { scope: "test", identifier: "client", limit: 2, windowMs: 1_000 };
  assert.equal(consumeRateLimit({ ...input, now: 10_000 }).allowed, true);
  assert.equal(consumeRateLimit({ ...input, now: 10_100 }).allowed, true);
  const denied = consumeRateLimit({ ...input, now: 10_200 });
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterSeconds, 1);
  assert.equal(consumeRateLimit({ ...input, now: 11_001 }).allowed, true);
});
