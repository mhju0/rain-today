import assert from "node:assert/strict";
import test from "node:test";
import { buildPirateWeatherUrl } from "./pirate-weather.ts";

test("Pirate Weather URL keeps credentials on the fixed upstream origin", () => {
  const url = buildPirateWeatherUrl("0123456789abcdef");
  assert.equal(url.origin, "https://api.pirateweather.net");
  assert.equal(url.searchParams.get("units"), "si");
  assert.match(url.pathname, /^\/forecast\/0123456789abcdef\//);
});

test("Pirate Weather URL rejects path and query injection in credentials", () => {
  for (const key of ["short", "0123456789abcdef/../admin", "0123456789abcdef?units=us"]) {
    assert.throws(() => buildPirateWeatherUrl(key), /invalid API key format/);
  }
});
