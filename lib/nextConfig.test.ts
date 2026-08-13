import assert from "node:assert/strict";
import test from "node:test";
import nextConfig from "../next.config.ts";

test("permissions policy allows the user-triggered same-origin location flow", async () => {
  assert.equal(typeof nextConfig.headers, "function");
  const rules = await nextConfig.headers!();
  const policy = rules
    .flatMap((rule) => rule.headers)
    .find((header) => header.key === "Permissions-Policy")?.value;

  assert.equal(
    policy,
    "camera=(), microphone=(), geolocation=(self), payment=()",
  );
});
