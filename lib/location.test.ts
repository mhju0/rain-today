import assert from "node:assert/strict";
import test from "node:test";
import {
  createForecastLocation,
  forecastLocationCacheKey,
  locationToKmaGrid,
} from "./location.ts";

test("createForecastLocation normalizes a Korean forecast target", () => {
  assert.deepEqual(
    createForecastLocation({ name: "서울 중구", latitude: 37.5665, longitude: 126.978 }),
    {
      name: "서울 중구",
      latitude: 37.5665,
      longitude: 126.978,
      countryCode: "KR",
      timezone: "Asia/Seoul",
      kmaGrid: { nx: 60, ny: 127 },
    },
  );
});

test("createForecastLocation rejects non-finite and out-of-service coordinates", () => {
  assert.throws(
    () => createForecastLocation({ name: "invalid", latitude: Number.NaN, longitude: 127 }),
    /finite/,
  );
  assert.throws(
    () => createForecastLocation({ name: "Tokyo", latitude: 35.6762, longitude: 139.6503 }),
    /South Korea/,
  );
});

test("locationToKmaGrid matches known Korean forecast-grid points", () => {
  assert.deepEqual(locationToKmaGrid(37.5665, 126.978), { nx: 60, ny: 127 });
  assert.deepEqual(locationToKmaGrid(35.1796, 129.0756), { nx: 98, ny: 76 });
  assert.deepEqual(locationToKmaGrid(33.4996, 126.5312), { nx: 53, ny: 38 });
});

test("forecastLocationCacheKey hides exact coordinates without merging distinct fixes", () => {
  const firstFix = createForecastLocation({
    name: "현재 위치",
    latitude: 37.5662,
    longitude: 126.9782,
  });
  const nearbyFix = createForecastLocation({
    name: "현재 위치",
    latitude: 37.5664,
    longitude: 126.9784,
  });
  const sameFix = createForecastLocation({
    name: "다른 표시 이름",
    latitude: 37.5662,
    longitude: 126.9782,
  });

  const key = forecastLocationCacheKey(firstFix);
  assert.match(key, /^kr:[A-Za-z0-9_-]{22}$/);
  assert.equal(key, forecastLocationCacheKey(sameFix));
  assert.notEqual(key, forecastLocationCacheKey(nearbyFix));
  assert.equal(key.includes("37.5662"), false);
  assert.equal(key.includes("126.9782"), false);
});
