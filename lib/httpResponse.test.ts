import assert from "node:assert/strict";
import test from "node:test";
import { readResponseBytes } from "./httpResponse.ts";

test("readResponseBytes accepts a bounded response", async () => {
  const response = new Response("weather", {
    headers: { "Content-Length": "7", "Content-Type": "text/plain" },
  });
  const bytes = await readResponseBytes(response, { maxBytes: 8, contentType: "text/plain" });
  assert.equal(new TextDecoder().decode(bytes), "weather");
});

test("readResponseBytes rejects declared and streamed oversized bodies", async () => {
  await assert.rejects(
    readResponseBytes(new Response("x", { headers: { "Content-Length": "100" } }), { maxBytes: 8 }),
    /too large/,
  );
  await assert.rejects(readResponseBytes(new Response("123456789"), { maxBytes: 8 }), /too large/);
});

test("readResponseBytes rejects an unexpected content type", async () => {
  await assert.rejects(
    readResponseBytes(new Response("{}", { headers: { "Content-Type": "text/html" } }), {
      maxBytes: 8,
      contentType: "application/json",
    }),
    /content type/,
  );
});
