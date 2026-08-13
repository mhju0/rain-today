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

test("forecastLocationCacheKey separates materially different coordinates", () => {
  const seoul = createForecastLocation({ name: "서울", latitude: 37.5665, longitude: 126.978 });
  const busan = createForecastLocation({ name: "부산", latitude: 35.1796, longitude: 129.0756 });

  assert.equal(forecastLocationCacheKey(seoul), "kr:37.5665:126.9780");
  assert.notEqual(forecastLocationCacheKey(seoul), forecastLocationCacheKey(busan));
});
