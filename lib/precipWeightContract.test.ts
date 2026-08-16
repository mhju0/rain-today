import assert from "node:assert/strict";
import test from "node:test";
import { normalizeClamped as performanceProjection } from "./performance/performance.ts";
import { normalizeClamped as reliabilityProjection, W_CAP, W_FLOOR } from "./reliability/weights.ts";

/**
 * SeoulSky runs two precipitation-scoring pipelines that share a vocabulary and
 * a bounded-weight contract but not an implementation: the nationwide
 * Recent Performance Profile in `lib/performance/`, and the single-station
 * reliability pipeline in `lib/reliability/`. Both project raw scores onto
 * { sum = 1, floor <= w <= cap }; `lib/performance/` water-fills, and
 * `lib/reliability/` iterates clamp-and-renormalize to a fixed point.
 *
 * These tests pin what the two genuinely share, and pin the fact that they are
 * NOT interchangeable, so a future consolidation is a deliberate scoring change
 * rather than an accident. See docs/adr/0004-two-precipitation-scoring-pipelines.md.
 */

const PROJECTIONS = [
  ["performance", performanceProjection],
  ["reliability", reliabilityProjection],
] as const;

function samples(): Record<string, number>[] {
  // Deterministic sweep; no Math.random so a failure is always reproducible.
  let seed = 20260816;
  const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const cases: Record<string, number>[] = [];
  for (let trial = 0; trial < 2000; trial += 1) {
    const size = 2 + Math.floor(next() * 4);
    const raw: Record<string, number> = {};
    for (let index = 0; index < size; index += 1) {
      raw[`p${index}`] = trial % 3 === 0 && next() < 0.3 ? 0 : next() * (trial % 2 ? 1 : 50);
    }
    cases.push(raw);
  }
  return cases;
}

for (const [name, project] of PROJECTIONS) {
  test(`${name} weight projection keeps every weight inside the bounded simplex`, () => {
    for (const raw of samples()) {
      const weights = project(raw, W_FLOOR, W_CAP);
      const values = Object.values(weights);
      const total = values.reduce((sum, value) => sum + value, 0);

      assert.ok(Math.abs(total - 1) < 1e-9, `${name} weights must sum to one`);
      assert.ok(
        values.every((value) => value >= W_FLOOR - 1e-9),
        `${name} silenced a source below the floor`,
      );
      assert.ok(
        values.every((value) => value <= W_CAP + 1e-9),
        `${name} trusted a source beyond the cap`,
      );
    }
  });

  test(`${name} weight projection never inverts the raw ordering`, () => {
    for (const raw of samples()) {
      const weights = project(raw, W_FLOOR, W_CAP);
      for (const better of Object.keys(raw)) {
        for (const worse of Object.keys(raw)) {
          if (raw[better] <= raw[worse] + 1e-9) continue;
          assert.ok(
            weights[better] >= weights[worse] - 1e-9,
            `${name} gave a worse source more influence`,
          );
        }
      }
    }
  });
}

test("the two weight projections are not interchangeable", () => {
  // A source with no raw score at all: water-filling leaves it at the floor and
  // gives the surplus to the source that earned it; the fixed-point iteration
  // levels the three low sources together instead. Both respect the contract
  // above, so neither is wrong — they are different policies, and swapping one
  // for the other changes served influence.
  const raw = { "open-meteo": 0.96, kma: 0.036, "met-norway": 0, "pirate-weather": 0 };

  const performance = performanceProjection(raw, W_FLOOR, W_CAP);
  const reliability = reliabilityProjection(raw, W_FLOOR, W_CAP);

  assert.ok(Math.abs(performance.kma - 0.3) < 1e-9);
  assert.ok(Math.abs(performance["met-norway"] - W_FLOOR) < 1e-9);
  assert.ok(Math.abs(reliability.kma - reliability["met-norway"]) < 1e-9);
  assert.ok(
    Math.abs(performance.kma - reliability.kma) > 0.1,
    "if these have converged, read ADR 0004 before deleting either implementation",
  );
});
