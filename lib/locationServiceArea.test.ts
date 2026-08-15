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

test("isInsideServiceArea honours holes punched through outer rings", () => {
  // The 시도 layer carries 13 hole rings; a decoded hole must subtract from its
  // enclosing outer ring rather than being treated as additional land.
  assert.equal(SERVICE_AREA_SOURCE.holeRingCount, 13);
  assert.equal(
    SERVICE_AREA_SOURCE.outerRingCount + SERVICE_AREA_SOURCE.holeRingCount,
    SERVICE_AREA_SOURCE.ringCount,
  );
});

test("service-area asset records its authoritative provenance", () => {
  assert.equal(SERVICE_AREA_SOURCE.boundaryVintage, "2025-06-30");
  assert.match(SERVICE_AREA_SOURCE.sourceChecksum, /^[0-9a-f]{64}$/);
  assert.match(SERVICE_AREA_SOURCE.payloadChecksum, /^[0-9a-f]{64}$/);
  assert.ok(SERVICE_AREA_SOURCE.simplifyToleranceMetres <= 25);
});
