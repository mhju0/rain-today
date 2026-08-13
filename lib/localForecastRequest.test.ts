import assert from "node:assert/strict";
import test from "node:test";
import { parseLocalForecastRequest } from "./localForecastRequest.ts";

test("local forecast request accepts a precise Korean coordinate without storing it", () => {
  const request = new Request(
    "https://example.test/api/local-forecast?lat=35.1532&lon=129.1187&name=%EB%B6%80%EC%82%B0%20%EC%88%98%EC%98%81%EA%B5%AC&elevation=12",
  );
  const parsed = parseLocalForecastRequest(request);
  assert.equal(parsed.location.name, "부산 수영구");
  assert.equal(parsed.location.kmaGrid.nx > 0, true);
  assert.equal(parsed.elevationM, 12);
});

test("local forecast request rejects coordinates outside Korea and invalid elevation", () => {
  assert.throws(
    () => parseLocalForecastRequest(new Request("https://x.test?lat=35.6&lon=139.6")),
    /service area/,
  );
  assert.throws(
    () => parseLocalForecastRequest(new Request("https://x.test?lat=37.5&lon=127&elevation=mountain")),
    /elevation/,
  );
});
