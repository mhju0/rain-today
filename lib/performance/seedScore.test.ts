import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PERFORMANCE_POLICY } from "./performance.ts";
import {
  buildSeedProfile,
  SEED_INFLUENCE,
  seedEffectiveWeights,
  seedProviderPerformance,
} from "./seedScore.ts";
import type { PrecipProviderId, SeedComparison } from "./types.ts";

const POLICY = DEFAULT_PERFORMANCE_POLICY;

/**
 * Build `count` seed days. `skilful` forecasts the observation; `blind` always
 * forecasts dry, so it misses every wet day.
 */
function history(count: number, wetEvery = 3): SeedComparison[] {
  return Array.from({ length: count }, (_, index) => {
    const wet = index % wetEvery === 0;
    const observedMm = wet ? 5 : 0;
    return {
      stationId: "108",
      targetDate: new Date(Date.parse("2025-06-01T00:00:00.000Z") + index * 86_400_000)
        .toISOString()
        .slice(0, 10),
      providers: [
        { provider: "open-meteo" as PrecipProviderId, amountMm: observedMm },
        { provider: "kma" as PrecipProviderId, amountMm: 0 },
      ],
      observedMm,
      builtAt: "2026-08-18T00:00:00.000Z",
    };
  });
}

test("a provider is not mature until it clears the minimum sample bar", () => {
  const short = seedProviderPerformance("open-meteo", history(POLICY.minimumSamples - 1), POLICY);
  const long = seedProviderPerformance("open-meteo", history(POLICY.minimumSamples), POLICY);

  assert.equal(short!.eligible, false);
  assert.equal(long!.eligible, true);
});

test("a provider needs both a wet and a dry day to be mature", () => {
  const allDry: SeedComparison[] = history(40).map((row) => ({
    ...row,
    observedMm: 0,
    providers: [{ provider: "open-meteo", amountMm: 0 }],
  }));

  const performance = seedProviderPerformance("open-meteo", allDry, POLICY);
  assert.equal(performance!.wetDays, 0);
  assert.equal(performance!.eligible, false, "a station that never rained proves nothing");
});

test("correct-dry days count as samples but carry no skill", () => {
  const performance = seedProviderPerformance("open-meteo", history(30), POLICY)!;

  assert.equal(performance.sampleCount, 30);
  assert.ok(performance.scoredCount < performance.sampleCount, "dry days are not informative");
  assert.equal(performance.misses, 0);
});

test("a provider that always forecasts dry is scored as missing every wet day", () => {
  const performance = seedProviderPerformance("kma", history(30), POLICY)!;

  assert.equal(performance.misses, performance.wetDays);
  assert.equal(performance.falseAlarms, 0);
});

test("a provider absent from the archive is simply absent", () => {
  assert.equal(seedProviderPerformance("weather-api", history(30), POLICY), null);
});

test("the better provider earns more weight, within the bound", () => {
  const profile = buildSeedProfile({
    comparisons: history(45),
    providers: ["open-meteo", "kma"],
    policy: POLICY,
  });

  assert.equal(profile.ready, true);
  assert.ok(
    profile.weights["open-meteo"] > profile.weights.kma,
    "the accurate provider must outrank the one that missed every wet day",
  );
  assert.ok(profile.weights["open-meteo"] <= POLICY.weightCap + 1e-9, "cap holds");
  assert.ok(profile.weights.kma >= POLICY.weightFloor - 1e-9, "floor holds");
  const total = Object.values(profile.weights).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, "weights sum to 1");
});

test("fewer than two mature providers is not ready, and stays equal", () => {
  const profile = buildSeedProfile({
    comparisons: history(5),
    providers: ["open-meteo", "kma"],
    policy: POLICY,
  });

  assert.equal(profile.ready, false);
  assert.deepEqual(profile.weights, { "open-meteo": 0.5, kma: 0.5 });
});

test("a provider with no seed evidence lands near equal rather than demoted", () => {
  const profile = buildSeedProfile({
    comparisons: history(45),
    providers: ["open-meteo", "kma", "weather-api"],
    policy: POLICY,
  });

  const equal = 1 / 3;
  assert.ok(
    Math.abs(profile.weights["weather-api"] - equal) < Math.abs(profile.weights.kma - equal),
    "no opinion must not be punished harder than a measured bad one",
  );
});

test("seed influence is capped, never applied at full strength", () => {
  const seedWeights = { "open-meteo": 0.6, kma: 0.4 };
  const effective = seedEffectiveWeights(seedWeights, ["open-meteo", "kma"]);

  assert.equal(effective["open-meteo"], 0.5 + SEED_INFLUENCE * 0.1);
  assert.ok(
    Math.abs(effective["open-meteo"] - 0.5) < Math.abs(seedWeights["open-meteo"] - 0.5),
    "the effective weight must sit between equal and the raw seed weight",
  );
  const total = Object.values(effective).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, "the blend preserves total mass");
});

test("a provider missing from the seed weights keeps its equal share", () => {
  const effective = seedEffectiveWeights({ "open-meteo": 1 }, ["open-meteo", "weather-api"]);
  assert.equal(effective["weather-api"], 0.5);
});
