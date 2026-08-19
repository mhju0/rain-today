import { test } from "node:test";
import assert from "node:assert/strict";
import { buildForecastBlocks, periodNameForHour } from "./blocks.ts";
import type { HourlyForecast, WeatherCondition } from "../types.ts";

// --- fixtures ---------------------------------------------------------------

const h = (
  time: string,
  temperature: number,
  precipitationProbability: number | null,
  condition: WeatherCondition = "clear",
): HourlyForecast => ({ time, temperature, precipitationProbability, windSpeed: null, humidity: null, condition });

/**
 * `count` consecutive hourly entries whose first entry sits at KST hour
 * `startKstHour`. Times are real instants (UTC ISO) so kstHour() resolves the
 * Seoul wall-clock hour regardless of the machine timezone.
 */
function seq(startKstHour: number, count: number, temp = 20): HourlyForecast[] {
  const base = Date.parse(`2026-06-19T${String(startKstHour).padStart(2, "0")}:00:00+09:00`);
  return Array.from({ length: count }, (_, i) => h(new Date(base + i * 3600_000).toISOString(), temp, null));
}

// --- period mapping at the band boundaries ----------------------------------

test("periodNameForHour: band boundaries", () => {
  assert.equal(periodNameForHour(0), "새벽");
  assert.equal(periodNameForHour(5), "새벽");
  assert.equal(periodNameForHour(6), "아침");
  assert.equal(periodNameForHour(11), "오전");
  assert.equal(periodNameForHour(12), "오후");
  assert.equal(periodNameForHour(17), "오후");
  assert.equal(periodNameForHour(18), "저녁");
  assert.equal(periodNameForHour(20), "저녁");
  assert.equal(periodNameForHour(21), "밤");
  assert.equal(periodNameForHour(23), "밤");
});

// --- labels: block 0 is "지금"; later blocks take the midpoint period --------

test("buildForecastBlocks: block 0 label is 지금, later blocks use midpoint period", () => {
  const blocks = buildForecastBlocks(seq(0, 15));
  assert.equal(blocks.length, 5);
  assert.equal(blocks[0].label, "지금"); // hours 0,1,2
  assert.equal(blocks[1].label, "새벽"); // midpoint hour 4
  assert.equal(blocks[2].label, "아침"); // midpoint hour 7
  assert.equal(blocks[3].label, "오전"); // midpoint hour 10
  assert.equal(blocks[4].label, "오후"); // midpoint hour 13
});

test("buildForecastBlocks: representativeTime anchors block 0 on entries[0], others on midpoint", () => {
  const hourly = seq(9, 6);
  const blocks = buildForecastBlocks(hourly);
  assert.equal(blocks[0].representativeTime, hourly[0].time);
  assert.equal(blocks[1].representativeTime, hourly[4].time); // midpoint of entries[3..5]
});

// --- temperature aggregation + rounding -------------------------------------

test("buildForecastBlocks: hi/lo are the rounded max/min of the block", () => {
  const t0 = "2026-06-19T15:00:00+09:00";
  const t1 = "2026-06-19T16:00:00+09:00";
  const t2 = "2026-06-19T17:00:00+09:00";
  const [block] = buildForecastBlocks([h(t0, 10.4, null), h(t1, 20.6, null), h(t2, 15, null)]);
  assert.equal(block.tempHigh, 21);
  assert.equal(block.tempLow, 10);
  assert.equal(block.rangeLabel, "15–18시");
});

// --- precip: max of non-null, null only when every hour is null -------------

test("buildForecastBlocks: precipMax handles nulls honestly", () => {
  const ts = seq(0, 3).map((e) => e.time);
  const allNull = buildForecastBlocks([h(ts[0], 20, null), h(ts[1], 20, null), h(ts[2], 20, null)]);
  assert.equal(allNull[0].precipMax, null);

  const mixed = buildForecastBlocks([h(ts[0], 20, null), h(ts[1], 20, 30), h(ts[2], 20, 10)]);
  assert.equal(mixed[0].precipMax, 30);

  // A real 0% is data, not absence — must not collapse to null.
  const zeros = buildForecastBlocks([h(ts[0], 20, 0), h(ts[1], 20, 0), h(ts[2], 20, 0)]);
  assert.equal(zeros[0].precipMax, 0);
});

// --- representative condition ----------------------------------------------

test("buildForecastBlocks: condition follows the single wettest hour", () => {
  const ts = seq(0, 3).map((e) => e.time);
  const unique = buildForecastBlocks([
    h(ts[0], 20, 10, "cloudy"),
    h(ts[1], 20, 80, "rain"),
    h(ts[2], 20, 20, "cloudy"),
  ]);
  assert.equal(unique[0].condition, "rain");
});

test("buildForecastBlocks: ties/nulls fall back to the block's midpoint hour", () => {
  // Use block 1 (entries[3..5], midpoint entries[4]) so the midpoint is the
  // genuine middle hour — block 0's midpoint is entries[0] by design.
  const t = seq(0, 6).map((e) => e.time);

  const tied = buildForecastBlocks([
    h(t[0], 20, null), h(t[1], 20, null), h(t[2], 20, null),
    h(t[3], 20, 50, "rain"), h(t[4], 20, 30, "cloudy"), h(t[5], 20, 50, "snow"),
  ]);
  assert.equal(tied[1].condition, "cloudy"); // tie at 50 → midpoint entries[4]

  const allNull = buildForecastBlocks([
    h(t[0], 20, null), h(t[1], 20, null), h(t[2], 20, null),
    h(t[3], 20, null, "rain"), h(t[4], 20, null, "fog"), h(t[5], 20, null, "snow"),
  ]);
  assert.equal(allNull[1].condition, "fog"); // midpoint entries[4]
});

// --- reach: a full 24-hour series folds into eight blocks -------------------

test("buildForecastBlocks: a full 24-hour series yields eight blocks", () => {
  const blocks = buildForecastBlocks(seq(0, 24));
  assert.equal(blocks.length, 8);
  assert.equal(blocks[0].rangeLabel, "0–3시");
  assert.equal(blocks[7].rangeLabel, "21–0시"); // wall clock wraps at midnight
});

// --- short / empty data: build only what the series supports ----------------

test("buildForecastBlocks: short series yields fewer blocks, never an invented one", () => {
  assert.equal(buildForecastBlocks([]).length, 0);

  const seven = buildForecastBlocks(seq(0, 7));
  assert.equal(seven.length, 3); // [0-2], [3-5], [6]
  assert.equal(seven[2].rangeLabel, "6–7시"); // single trailing hour → end = hour + 1
});

// --- clock fields the horizontal ribbon anchors on --------------------------

test("buildForecastBlocks: startHour/endHour bracket the block, endHour wrapping past midnight", () => {
  const blocks = buildForecastBlocks(seq(21, 6));
  assert.equal(blocks[0].startHour, 21);
  assert.equal(blocks[0].endHour, 0); // 21,22,23 → exclusive end wraps to 0
  assert.equal(blocks[1].startHour, 0);
  assert.equal(blocks[1].endHour, 3);
});

test("buildForecastBlocks: startDate is the KST calendar date the block opens on", () => {
  const blocks = buildForecastBlocks(seq(21, 6));
  assert.equal(blocks[0].startDate, "2026-06-19");
  assert.equal(blocks[1].startDate, "2026-06-20");
});
