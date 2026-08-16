import assert from "node:assert/strict";
import test from "node:test";
import type { LocalForecastEvidence, LocalForecastResponse } from "./localForecast.ts";
import { toLocalForecastView } from "./localForecastView.ts";
import type { ProviderRecentPerformance, RecentPerformanceProfile } from "./performance/types.ts";

const REASONS: LocalForecastEvidence["reason"][] = [
  "eligible-station",
  "insufficient-evidence",
  "benchmark-insufficient",
  "benchmark-regression",
  "no-eligible-station",
  "database-not-configured",
  "database-unavailable",
];

function providerScore(
  provider: ProviderRecentPerformance["provider"],
  windowSampleCount: number,
): ProviderRecentPerformance {
  return {
    provider,
    sampleCount: windowSampleCount,
    windowSampleCount,
    wetDays: 10,
    dryDays: 20,
    misses: 2,
    falseAlarms: 3,
    brierScore: 0.15,
    rainyAmountSampleCount: 4,
    rainyAmountMae: 1.5,
    last7Days: { sampleCount: 7, brierScore: 0.12 },
    eligible: true,
  };
}

function profile(providers: ProviderRecentPerformance[]): RecentPerformanceProfile {
  return {
    stationId: "108",
    cohort: "06",
    generatedAt: "2026-08-14T00:00:00.000Z",
    windowStart: "2026-07-15",
    windowEnd: "2026-08-14",
    mode: "learned",
    reason: "learned",
    rampProgress: 1,
    providers,
    effectiveWeights: { "open-meteo": 0.6, kma: 0.4 },
    prospectiveBenchmark: {
      sampleCount: 30,
      adaptiveBrier: 0.14,
      equalBrier: 0.18,
      openMeteoBrier: 0.12,
      kmaBrier: 0.22,
      status: "passing",
    },
  };
}

function response(overrides: Partial<LocalForecastResponse> = {}): LocalForecastResponse {
  return {
    generatedAt: "2026-08-14T00:00:00.000Z",
    location: {
      name: "서울 종로구",
      latitude: 37.5714,
      longitude: 126.9658,
      countryCode: "KR",
      timezone: "Asia/Seoul",
      kmaGrid: { nx: 60, ny: 127 },
    },
    targetDate: "2026-08-15",
    captureCohort: "06",
    recommendation: {
      precipitationProbability: 68,
      precipitationAmountMm: 5,
      temperatureMax: 31,
      temperatureMin: 24,
      condition: "rain",
    },
    outlook: [],
    providers: [
      { id: "kma", name: "기상청 단기예보 (KMA)", probability: 50, amountMm: null, available: true },
      { id: "open-meteo", name: "Open-Meteo", probability: 80, amountMm: 5, available: true },
      { id: "met-norway", name: "MET Norway", probability: null, amountMm: null, available: false },
    ],
    effectiveInfluence: { kma: 0.4, "open-meteo": 0.6 },
    performance: {
      status: "active",
      reason: "eligible-station",
      station: { id: "108", name: "서울", distanceKm: 3.2 },
      profile: profile([providerScore("open-meteo", 44), providerScore("kma", 31)]),
    },
    ...overrides,
  };
}

test("every reason the evidence can be missing has its own copy", () => {
  const messages = REASONS.map((reason) =>
    toLocalForecastView(
      response({
        performance: { status: "unavailable", reason, station: null, profile: null },
      }),
    ).evidence.emptyMessage,
  );

  assert.ok(messages.every((message) => typeof message === "string" && message.length > 0));
  assert.equal(new Set(messages).size, REASONS.length, "two reasons share the same copy");
});

test("an unreachable database does not claim evidence is still accumulating", () => {
  const unavailable = toLocalForecastView(
    response({
      performance: {
        status: "unavailable",
        reason: "database-unavailable",
        station: null,
        profile: null,
      },
    }),
  );
  const collecting = toLocalForecastView(
    response({
      performance: {
        status: "collecting",
        reason: "insufficient-evidence",
        station: null,
        profile: null,
      },
    }),
  );

  assert.notEqual(unavailable.evidence.emptyMessage, collecting.evidence.emptyMessage);
});

test("influence arrives sorted, named, and joined to each provider's probability", () => {
  const view = toLocalForecastView(response());

  assert.deepEqual(view.influence.map((entry) => entry.id), ["open-meteo", "kma"]);
  // The compact name, not the long provider status name, so the bars still fit.
  assert.equal(view.influence[1].name, "기상청");
  assert.equal(view.influence[1].probability, 50);
  assert.equal(view.comparedProviderCount, 2);
  assert.equal(view.blendMode, "learned");
});

test("the comparison count shown is the weakest provider's, not the best", () => {
  const view = toLocalForecastView(response());

  assert.equal(view.evidence.comparisonSampleCount, 31);
});

test("the view carries no station coordinates or raw profile", () => {
  const view = toLocalForecastView(response());
  const serialized = JSON.stringify(view);

  assert.equal("profile" in view.evidence, false);
  assert.equal(serialized.includes("effectiveWeights"), false);
  assert.equal(serialized.includes("126.9658"), false);
  assert.deepEqual(view.evidence.station, { name: "서울", distanceKm: 3.2 });
});

test("scores are omitted rather than faked when no profile exists", () => {
  const view = toLocalForecastView(
    response({
      performance: {
        status: "collecting",
        reason: "insufficient-evidence",
        station: { id: "108", name: "서울", distanceKm: 3.2 },
        profile: null,
      },
    }),
  );

  assert.deepEqual(view.evidence.scores, []);
  assert.equal(view.evidence.benchmark, null);
  assert.equal(view.evidence.comparisonSampleCount, 0);
});
