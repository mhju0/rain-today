import assert from "node:assert/strict";
import test from "node:test";
import { SERVICE_AREA_SOURCE, isInsideServiceArea } from "./locationServiceArea.ts";

/**
 * Every point below is justified against the official SGIS 시도 geometry in
 * docs/research/sgis-boundary-acquisition.md. Island points are interior land
 * coordinates: plausible-looking centre coordinates for 추자도, 마라도, and 독도
 * fall in water and would reject against correct geometry.
 */
const INSIDE: ReadonlyArray<readonly [string, number, number]> = [
  ["서울 시청", 37.5665, 126.978],
  ["부산", 35.1796, 129.0756],
  ["강릉", 37.7519, 128.8761],
  ["제주시", 33.4996, 126.5312],
  ["우도", 33.5057, 126.9514],
  ["추자도", 33.96, 126.295],
  ["마라도", 33.1167, 126.2681],
  ["울릉도", 37.4845, 130.9057],
  ["독도 동도", 37.24, 131.869],
  ["독도 서도", 37.242, 131.865],
  ["백령도", 37.9636, 124.6797],
  ["대청도", 37.8236, 124.7069],
  ["연평도", 37.6636, 125.6981],
  ["흑산도", 34.6819, 125.4344],
];

/**
 * The first four points sit inside the previous rectangular bounds
 * (latitude 32.75–38.65, longitude 124.5–132) and must now reject.
 */
const OUTSIDE: ReadonlyArray<readonly [string, number, number]> = [
  ["개성 (북한)", 37.97, 126.55],
  ["대마도 (일본)", 34.4028, 129.3],
  ["황해", 36.5, 125.0],
  ["대한해협", 34.0, 128.5],
  ["동해", 37.0, 130.0],
  ["이어도", 32.1225, 125.1822],
  ["후쿠오카 (일본)", 33.5904, 130.4017],
  ["도쿄 (일본)", 35.6762, 139.6503],
  ["평양 (북한)", 39.0392, 125.7625],
];

test("isInsideServiceArea accepts mainland and every required island", () => {
  for (const [name, latitude, longitude] of INSIDE) {
    assert.equal(isInsideServiceArea(latitude, longitude), true, `${name} must be inside`);
  }
});

test("isInsideServiceArea rejects foreign land, sea, and out-of-service points", () => {
  for (const [name, latitude, longitude] of OUTSIDE) {
    assert.equal(isInsideServiceArea(latitude, longitude), false, `${name} must be outside`);
  }
});

test("isInsideServiceArea rejects non-finite coordinates", () => {
  assert.equal(isInsideServiceArea(Number.NaN, 127), false);
  assert.equal(isInsideServiceArea(37.5, Number.POSITIVE_INFINITY), false);
});

/**
 * 전라남도 fully encloses 광주광역시, so 전남's polygon carries a hole exactly
 * where 광주 sits. A hole must only ever subtract from its own feature: treating
 * holes layer-wide rejects every coordinate in a city of 1.4 million people.
 */
test("a hole in one province never cancels an enclosed province", () => {
  for (const [name, latitude, longitude] of [
    ["광주광역시 시청", 35.1601, 126.8514],
    ["광주 충장로", 35.149, 126.919],
    ["광주 광산구", 35.1396, 126.7936],
    ["광주 북구", 35.174, 126.912],
    // KMA ASOS 156, requested every capture cycle by lib/performance/capture.ts.
    ["광주 ASOS 156", 35.17294, 126.89156],
  ] as const) {
    assert.equal(isInsideServiceArea(latitude, longitude), true, `${name} must be inside`);
  }
});

/** Every 시도 must be reachable; a whole province silently dropping out is the failure to catch. */
test("every 시도 has a representative point inside the service area", () => {
  const representatives: ReadonlyArray<readonly [string, number, number]> = [
    ["서울특별시", 37.5665, 126.978],
    ["부산광역시", 35.1796, 129.0756],
    ["대구광역시", 35.8714, 128.6014],
    ["인천광역시", 37.4563, 126.7052],
    ["광주광역시", 35.1601, 126.8514],
    ["대전광역시", 36.3504, 127.3845],
    ["울산광역시", 35.5384, 129.3114],
    ["세종특별자치시", 36.48, 127.289],
    ["경기도", 37.2636, 127.0286],
    ["강원특별자치도", 37.8813, 127.73],
    ["충청북도", 36.6424, 127.489],
    ["충청남도", 36.6588, 126.6728],
    ["전북특별자치도", 35.8242, 127.148],
    ["전라남도", 34.8161, 126.463],
    ["경상북도", 36.5684, 128.7294],
    ["경상남도", 35.228, 128.6811],
    ["제주특별자치도", 33.4996, 126.5312],
  ];
  assert.equal(representatives.length, SERVICE_AREA_SOURCE.featureCount);
  for (const [name, latitude, longitude] of representatives) {
    assert.equal(isInsideServiceArea(latitude, longitude), true, `${name} must be inside`);
  }
});

test("service-area asset records its authoritative provenance", () => {
  // Asserted as shape, not as today's literal: a regenerated asset must be able
  // to carry a newer vintage without a stale label passing this suite.
  assert.match(SERVICE_AREA_SOURCE.boundaryVintage, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(SERVICE_AREA_SOURCE.sourceChecksum, /^[0-9a-f]{64}$/);
  assert.match(SERVICE_AREA_SOURCE.payloadChecksum, /^[0-9a-f]{64}$/);
  assert.equal(
    SERVICE_AREA_SOURCE.outerRingCount + SERVICE_AREA_SOURCE.holeRingCount,
    SERVICE_AREA_SOURCE.ringCount,
  );
});
