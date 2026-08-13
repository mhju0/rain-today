import assert from "node:assert/strict";
import test from "node:test";
import { parseLocalForecastRequest } from "./localForecastRequest.ts";

test("local forecast request accepts a precise Korean coordinate from a JSON body", async () => {
  const request = new Request(
    "https://example.test/api/local-forecast",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        latitude: 35.1532,
        longitude: 129.1187,
        name: "부산 수영구",
        elevationM: 12,
      }),
    },
  );
  const parsed = await parseLocalForecastRequest(request);
  assert.equal(parsed.location.name, "부산 수영구");
  assert.equal(parsed.location.kmaGrid.nx > 0, true);
  assert.equal(parsed.elevationM, 12);
});

test("local forecast request rejects coordinates outside Korea and invalid elevation", async () => {
  const bodyRequest = (body: unknown) => new Request("https://x.test/api/local-forecast", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await assert.rejects(
    () => parseLocalForecastRequest(bodyRequest({ latitude: 35.6, longitude: 139.6 })),
    /service area/,
  );
  await assert.rejects(
    () => parseLocalForecastRequest(bodyRequest({ latitude: 37.5, longitude: 127, elevationM: "mountain" })),
    /elevation/,
  );
});

test("local forecast request rejects an oversized streamed JSON body", async () => {
  const request = new Request("https://x.test/api/local-forecast", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ latitude: 37.5, longitude: 127 }) + " ".repeat(5_000),
  });

  await assert.rejects(
    () => parseLocalForecastRequest(request),
    /body too large/,
  );
});
