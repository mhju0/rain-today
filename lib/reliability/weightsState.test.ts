import assert from "node:assert/strict";
import test from "node:test";
import type { WeightsState } from "./types.ts";
import { parseWeightsState } from "./weightsState.ts";

const validState: WeightsState = {
  updatedAt: "2026-07-10T21:13:00.000Z",
  eventsScored: 51,
  processedDates: ["2026-07-09", "2026-07-10"],
  weights: {
    "open-meteo": 0.4,
    "met-norway": 0.15,
    kma: 0.15,
    "pirate-weather": 0.15,
    "weather-api": 0.15,
  },
};

test("parseWeightsState accepts a complete normalized learned state", () => {
  assert.deepEqual(parseWeightsState(validState), validState);
  assert.deepEqual(
    parseWeightsState({ ...validState, updatedAt: "2026-07-11T06:13:00.000+09:00" }),
    { ...validState, updatedAt: "2026-07-11T06:13:00.000+09:00" },
  );
});

test("parseWeightsState rejects state that is unsafe for runtime weighting", () => {
  const invalid: unknown[] = [
    null,
    { ...validState, updatedAt: "not-a-date" },
    { ...validState, updatedAt: "2026-07-10T21:13:00.000" },
    { ...validState, updatedAt: "2026-02-30T21:13:00.000Z" },
    { ...validState, eventsScored: -1 },
    { ...validState, eventsScored: 1.5 },
    { ...validState, processedDates: ["2026-07-10", "not-a-date"] },
    { ...validState, processedDates: ["2026-07-10", "2026-07-10"] },
    { ...validState, weights: {} },
    { ...validState, weights: { "open-meteo": -0.1, kma: 1.1 } },
    { ...validState, weights: { "open-meteo": 0.4, kma: 0.4 } },
  ];

  for (const candidate of invalid) assert.equal(parseWeightsState(candidate), null);
});
