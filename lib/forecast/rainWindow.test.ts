import { test } from "node:test";
import assert from "node:assert/strict";
import { buildForecastBlocks } from "./blocks.ts";
import { readTimeline } from "./rainWindow.ts";
import type { HourlyForecast } from "../types.ts";

/**
 * `probabilities` is one value per hour starting at KST `startKstHour` on
 * 2026-06-19. `null` stands for an hour the provider has not published.
 */
function hourly(startKstHour: number, probabilities: (number | null)[]): HourlyForecast[] {
  const base = Date.parse(`2026-06-19T${String(startKstHour).padStart(2, "0")}:00:00+09:00`);
  return probabilities.map((probability, i) => ({
    time: new Date(base + i * 3600_000).toISOString(),
    temperature: 20,
    precipitationProbability: probability,
    windSpeed: null,
    humidity: null,
    condition: "clear" as const,
  }));
}

/** One value per 3-hour block, expanded to the three hours it covers. */
function byBlock(startKstHour: number, blockValues: (number | null)[]): HourlyForecast[] {
  return hourly(
    startKstHour,
    blockValues.flatMap((value) => [value, value, value]),
  );
}

test("readTimeline: no block reaches the threshold", () => {
  const reading = readTimeline(buildForecastBlocks(byBlock(15, [10, 0, 5, 12])), 40);
  assert.equal(reading.firstRun, null);
  assert.equal(reading.laterRun, null);
  assert.deepEqual(reading.peak, { probability: 12, rangeLabel: "0–3시", startsTomorrow: true });
});

test("readTimeline: one run bracketed by dry blocks reports both ends", () => {
  //          15–18 18–21 21–00 00–03 03–06 06–09 09–12 12–15
  const blocks = buildForecastBlocks(byBlock(15, [18, 0, 0, 22, 55, 61, 44, 12]));
  const reading = readTimeline(blocks, 40);
  const run = reading.firstRun;
  assert.ok(run);
  assert.equal(run.startIndex, 4);
  assert.equal(run.endIndex, 6);
  assert.equal(run.startHour, 3);
  assert.equal(run.endHour, 12);
  assert.equal(run.startLabel, "새벽");
  assert.equal(run.startsTomorrow, true);
  assert.equal(run.durationHours, 9);
  assert.equal(run.endsWithinWindow, true);
  assert.equal(run.peakProbability, 61);
  assert.equal(reading.laterRun, null);
  assert.deepEqual(reading.peak, { probability: 61, rangeLabel: "6–9시", startsTomorrow: true });
});

test("readTimeline: a run reaching the last block has no known end", () => {
  const reading = readTimeline(buildForecastBlocks(byBlock(15, [10, 10, 10, 10, 10, 10, 70, 80])), 40);
  assert.ok(reading.firstRun);
  assert.equal(reading.firstRun.endsWithinWindow, false);
  assert.equal(reading.firstRun.durationHours, 6);
});

test("readTimeline: an unpublished block ends the run rather than extending it", () => {
  const reading = readTimeline(buildForecastBlocks(byBlock(15, [80, 80, null, 80, 0, 0, 0, 0])), 40);
  assert.ok(reading.firstRun);
  assert.equal(reading.firstRun.endIndex, 1);
  assert.equal(reading.firstRun.endsWithinWindow, true);
  assert.ok(reading.laterRun);
  assert.equal(reading.laterRun.startIndex, 3);
});

test("readTimeline: a block exactly at the threshold is wet", () => {
  const reading = readTimeline(buildForecastBlocks(byBlock(15, [40, 0, 0, 0, 0, 0, 0, 0])), 40);
  assert.ok(reading.firstRun);
  assert.equal(reading.firstRun.startIndex, 0);
  assert.equal(reading.firstRun.startLabel, "지금");
  assert.equal(reading.firstRun.startsTomorrow, false);
});

test("readTimeline: peak keeps the earliest block when two tie", () => {
  const reading = readTimeline(buildForecastBlocks(byBlock(15, [55, 0, 55, 0, 0, 0, 0, 0])), 40);
  assert.equal(reading.peak?.rangeLabel, "15–18시");
});

test("readTimeline: a partial trailing block contributes only the hours it covers", () => {
  // 15:00 → 20:59, so the second block holds 18h and 19h only.
  const reading = readTimeline(buildForecastBlocks(hourly(15, [70, 70, 70, 70, 70])), 40);
  assert.ok(reading.firstRun);
  assert.equal(reading.firstRun.durationHours, 5);
});

test("readTimeline: empty series reads as nothing at all", () => {
  const reading = readTimeline([], 40);
  assert.deepEqual(reading, { firstRun: null, laterRun: null, peak: null });
});
