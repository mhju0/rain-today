import assert from "node:assert/strict";
import test from "node:test";
import { findStationMatch } from "./stations.ts";
import type { ObservationStation } from "./types.ts";

const stations: ObservationStation[] = [
  {
    id: "near-high",
    name: "가까운 고지대",
    network: "ASOS",
    latitude: 37.57,
    longitude: 126.98,
    elevationM: 850,
    activeFrom: "2020-01-01",
    activeTo: null,
  },
  {
    id: "representative",
    name: "대표 관측소",
    network: "ASOS",
    latitude: 37.5,
    longitude: 127.02,
    elevationM: 80,
    activeFrom: "2020-01-01",
    activeTo: null,
  },
  {
    id: "closed",
    name: "종료 관측소",
    network: "ASOS",
    latitude: 37.55,
    longitude: 126.99,
    elevationM: 50,
    activeFrom: "2000-01-01",
    activeTo: "2025-12-31",
  },
];

test("Station Match applies activity, distance, and elevation gates", () => {
  const stationMatch = findStationMatch({
    location: { latitude: 37.5665, longitude: 126.978, elevationM: 30 },
    stations,
    at: new Date("2026-08-01T00:00:00+09:00"),
    policy: { maxDistanceKm: 40, maxElevationDifferenceM: 300 },
  });

  assert.equal(stationMatch.status, "matched");
  assert.equal(stationMatch.station?.id, "representative");
  assert.ok(stationMatch.distanceKm! > 0);
  assert.equal(stationMatch.elevationDifferenceM, 50);
});

test("Station Match returns an honest unavailable result outside the distance gate", () => {
  const stationMatch = findStationMatch({
    location: { latitude: 33.5, longitude: 126.5, elevationM: 20 },
    stations,
    at: new Date("2026-08-01T00:00:00+09:00"),
    policy: { maxDistanceKm: 20, maxElevationDifferenceM: 300 },
  });

  assert.deepEqual(stationMatch, {
    status: "unavailable",
    reason: "no-eligible-station",
    station: null,
    distanceKm: null,
    elevationDifferenceM: null,
  });
});
