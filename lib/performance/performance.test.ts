import assert from "node:assert/strict";
import test from "node:test";
import {
  blendPrecipProbability,
  buildLocalPerformanceProfile,
  DEFAULT_PERFORMANCE_POLICY,
} from "./performance.ts";
import type {
  CaptureCohort,
  ForecastCapture,
  PrecipObservation,
  PrecipProviderId,
} from "./types.ts";

const DAY_MS = 86_400_000;
const AS_OF = new Date("2026-08-01T12:00:00+09:00");

function dateDaysAgo(daysAgo: number): string {
  return new Date(AS_OF.getTime() - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

interface SeriesOptions {
  days: number;
  cohort?: CaptureCohort;
  probability(provider: PrecipProviderId, daysAgo: number, wet: boolean): number | null;
  amount?(provider: PrecipProviderId, daysAgo: number, wet: boolean): number | null;
  frozen?(daysAgo: number, wet: boolean): { adaptive: number | null; equal: number | null };
}

function series(options: SeriesOptions): {
  captures: ForecastCapture[];
  observations: PrecipObservation[];
} {
  const providers: PrecipProviderId[] = ["open-meteo", "kma"];
  const captures: ForecastCapture[] = [];
  const observations: PrecipObservation[] = [];
  for (let daysAgo = options.days; daysAgo >= 1; daysAgo--) {
    const targetDate = dateDaysAgo(daysAgo);
    const wet = daysAgo % 2 === 0;
    const frozen = options.frozen?.(daysAgo, wet) ?? { adaptive: 50, equal: 50 };
    captures.push({
      stationId: "108",
      targetDate,
      cohort: options.cohort ?? "06",
      capturedAt: `${targetDate}T06:00:00+09:00`,
      providers: providers.map((provider) => ({
        provider,
        probability: options.probability(provider, daysAgo, wet),
        amountMm: options.amount?.(provider, daysAgo, wet) ?? null,
      })),
      frozenBlend: {
        adaptiveProbability: frozen.adaptive,
        equalProbability: frozen.equal,
        influence: { "open-meteo": 0.5, kma: 0.5 },
      },
    });
    observations.push({
      stationId: "108",
      date: targetDate,
      observedMm: wet ? 10 : 0,
      observedAt: `${targetDate}T23:59:00+09:00`,
      source: "kma-asos",
    });
  }
  return { captures, observations };
}

test("probability performance includes completed dry days", () => {
  const data = series({
    days: 30,
    probability: () => 100,
  });

  const profile = buildLocalPerformanceProfile({
    stationId: "108",
    cohort: "06",
    ...data,
    asOf: AS_OF,
  });

  const provider = profile.providers.find((entry) => entry.provider === "open-meteo");
  assert.equal(provider?.sampleCount, 30);
  assert.equal(provider?.dryDays, 15);
  assert.equal(provider?.falseAlarms, 15);
  assert.ok((provider?.brierScore ?? 0) > 0);
});

test("operating performance uses a 30-day window with a 14-day recency half-life", () => {
  const data = series({
    days: 60,
    probability: (provider, daysAgo, wet) => {
      const recent = daysAgo <= 15;
      const openMeteoCorrect = recent;
      const correct = provider === "open-meteo" ? openMeteoCorrect : !openMeteoCorrect;
      if (correct) return wet ? 90 : 10;
      return wet ? 10 : 90;
    },
  });

  const profile = buildLocalPerformanceProfile({
    stationId: "108",
    cohort: "06",
    ...data,
    asOf: AS_OF,
  });

  const openMeteo = profile.providers.find((entry) => entry.provider === "open-meteo");
  const kma = profile.providers.find((entry) => entry.provider === "kma");
  assert.ok(openMeteo && kma);
  assert.ok(openMeteo.brierScore < kma.brierScore);
  assert.equal(openMeteo.windowSampleCount, 30);
  assert.equal(openMeteo.last7Days.sampleCount, 7);
});

test("fewer than 30 comparable captures cannot influence the forecast", () => {
  const data = series({
    days: 29,
    probability: (_provider, _daysAgo, wet) => (wet ? 80 : 20),
  });

  const profile = buildLocalPerformanceProfile({
    stationId: "108",
    cohort: "06",
    ...data,
    asOf: AS_OF,
  });

  assert.equal(profile.mode, "equal-fallback");
  assert.equal(profile.reason, "insufficient-evidence");
  assert.deepEqual(profile.effectiveWeights, { "open-meteo": 0.5, kma: 0.5 });
});

test("eligible recent performance tilts softly and remains bounded", () => {
  const data = series({
    days: 60,
    probability: (provider, _daysAgo, wet) =>
      provider === "open-meteo" ? (wet ? 90 : 10) : wet ? 30 : 70,
    frozen: (_daysAgo, wet) => ({ adaptive: wet ? 80 : 20, equal: 50 }),
  });

  const profile = buildLocalPerformanceProfile({
    stationId: "108",
    cohort: "06",
    ...data,
    asOf: AS_OF,
  });

  assert.equal(profile.mode, "learned");
  assert.ok(profile.effectiveWeights["open-meteo"] > profile.effectiveWeights.kma);
  assert.ok(profile.effectiveWeights["open-meteo"] <= 0.6);
  assert.ok(profile.effectiveWeights.kma >= 0.05);
  assert.ok(Math.abs(Object.values(profile.effectiveWeights).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test("a prospectively worse adaptive blend suspends learned influence", () => {
  const data = series({
    days: 60,
    probability: (provider, _daysAgo, wet) =>
      provider === "open-meteo" ? (wet ? 90 : 10) : wet ? 30 : 70,
    frozen: (_daysAgo, wet) => ({ adaptive: wet ? 10 : 90, equal: 50 }),
  });

  const profile = buildLocalPerformanceProfile({
    stationId: "108",
    cohort: "06",
    ...data,
    asOf: AS_OF,
  });

  assert.equal(profile.mode, "suspended");
  assert.equal(profile.reason, "benchmark-regression");
  assert.ok(profile.benchmark.adaptiveBrier! > profile.benchmark.equalBrier!);
  assert.deepEqual(profile.effectiveWeights, { "open-meteo": 0.5, kma: 0.5 });
});

test("benchmark compares adaptive and equal blends on identical captures", () => {
  const data = series({
    days: 32,
    probability: (_provider, _daysAgo, wet) => (wet ? 80 : 20),
    frozen: (daysAgo) => {
      if (daysAgo === 1) return { adaptive: 100, equal: null };
      if (daysAgo === 2) return { adaptive: null, equal: 100 };
      return { adaptive: 50, equal: 50 };
    },
  });

  const profile = buildLocalPerformanceProfile({
    stationId: "108",
    cohort: "06",
    ...data,
    asOf: AS_OF,
    policy: { ...DEFAULT_PERFORMANCE_POLICY, minimumSamples: 28 },
  });

  assert.equal(profile.benchmark.sampleCount, 28);
  assert.equal(profile.benchmark.adaptiveBrier, 0.25);
  assert.equal(profile.benchmark.equalBrier, 0.25);
  assert.equal(profile.benchmark.status, "passing");
});

test("provider metrics keep amount error separate and never invent missing amounts", () => {
  const data = series({
    days: 60,
    probability: (_provider, _daysAgo, wet) => (wet ? 80 : 20),
    amount: (provider, _daysAgo, wet) =>
      !wet || provider === "kma" ? null : 8,
  });

  const profile = buildLocalPerformanceProfile({
    stationId: "108",
    cohort: "06",
    ...data,
    asOf: AS_OF,
  });

  const openMeteo = profile.providers.find((entry) => entry.provider === "open-meteo");
  const kma = profile.providers.find((entry) => entry.provider === "kma");
  assert.equal(openMeteo?.rainyAmountSampleCount, 15);
  assert.equal(openMeteo?.rainyAmountMae, 2);
  assert.equal(kma?.rainyAmountSampleCount, 0);
  assert.equal(kma?.rainyAmountMae, null);
});

test("capture cohorts are evaluated independently", () => {
  const morning = series({
    days: 30,
    cohort: "06",
    probability: (_provider, _daysAgo, wet) => (wet ? 80 : 20),
  });
  const evening = series({
    days: 30,
    cohort: "18",
    probability: () => 50,
  });

  const profile = buildLocalPerformanceProfile({
    stationId: "108",
    cohort: "06",
    captures: [...morning.captures, ...evening.captures],
    observations: morning.observations,
    asOf: AS_OF,
  });

  assert.equal(profile.cohort, "06");
  assert.equal(profile.providers[0]?.sampleCount, 30);
});

test("serving-time blend renormalizes over probabilities that are actually present", () => {
  assert.equal(
    blendPrecipProbability(
      [
        { provider: "open-meteo", probability: 80, amountMm: 5 },
        { provider: "kma", probability: null, amountMm: null },
        { provider: "weather-api", probability: 20, amountMm: 1 },
      ],
      { "open-meteo": 0.6, kma: 0.3, "weather-api": 0.1 },
    ),
    71.42857142857143,
  );
  assert.equal(blendPrecipProbability([], {}), null);
});
