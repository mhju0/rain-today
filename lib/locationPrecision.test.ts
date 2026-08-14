import assert from "node:assert/strict";
import test from "node:test";
import {
  describeForecastLocationSelection,
  formatHorizontalAccuracy,
} from "./locationPrecision.ts";

test("browser horizontal accuracy is displayed without false precision", () => {
  assert.equal(formatHorizontalAccuracy(18.4), "약 20 m");
  assert.equal(formatHorizontalAccuracy(526), "약 500 m");
  assert.equal(formatHorizontalAccuracy(1_240), "약 1.2 km");
});

test("missing or invalid browser accuracy is not fabricated", () => {
  assert.equal(formatHorizontalAccuracy(null), "정확도 정보 없음");
  assert.equal(formatHorizontalAccuracy(Number.NaN), "정확도 정보 없음");
  assert.equal(formatHorizontalAccuracy(-1), "정확도 정보 없음");
});

test("administrative search selection is described as a representative point", () => {
  assert.deepEqual(
    describeForecastLocationSelection({ kind: "administrative-area" }),
    { source: "검색한 행정구역", precision: "행정구역 대표 위치" },
  );
});
