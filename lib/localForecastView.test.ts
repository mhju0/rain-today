import assert from "node:assert/strict";
import test from "node:test";
import type { LocalForecastEvidence, LocalForecastResponse } from "./localForecast.ts";
import { toLocalForecastView } from "./localForecastView.ts";
import type { ProviderRecentPerformance, RecentPerformanceProfile } from "./performance/types.ts";
import type { HourlyForecast } from "./types.ts";

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
    current: null,
    hourly: null,
    today: null,
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

test("observed conditions reach the client unchanged", () => {
  const view = toLocalForecastView(
    response({
      current: {
        temperature: 24.4,
        apparentTemperature: 26.1,
        condition: "overcast",
        observedAt: "2026-08-14T09:00:00+09:00",
        sourceName: "Open-Meteo",
      },
    }),
  );

  assert.deepEqual(view.current, {
    temperature: 24.4,
    apparentTemperature: 26.1,
    condition: "overcast",
    observedAt: "2026-08-14T09:00:00+09:00",
    sourceName: "Open-Meteo",
  });
});

test("a missing observation stays null rather than borrowing tomorrow's blend", () => {
  const view = toLocalForecastView(response({ current: null }));

  assert.equal(view.current, null);
  // The target-date recommendation is still present, so a client that fell back
  // to it would render tomorrow's sky as if it were happening outside now.
  assert.notEqual(view.recommendation.condition, undefined);
});

test("the sample-size explanation appears only where sample size is the reason", () => {
  const detailFor = (reason: LocalForecastEvidence["reason"]) =>
    toLocalForecastView(
      response({ performance: { status: "unavailable", reason, station: null, profile: null } }),
    ).evidence.emptyDetail;

  assert.match(detailFor("insufficient-evidence") ?? "", /30개/);
  assert.match(detailFor("benchmark-insufficient") ?? "", /30개/);
  // Jeju has no eligible station, so no amount of waiting produces 30 samples.
  assert.doesNotMatch(detailFor("no-eligible-station") ?? "", /30개/);
  assert.doesNotMatch(detailFor("database-not-configured") ?? "", /30개/);
});

test("the unconfigured-database message asks nothing of the visitor", () => {
  const view = toLocalForecastView(
    response({
      performance: {
        status: "unavailable",
        reason: "database-not-configured",
        station: null,
        profile: null,
      },
    }),
  );

  assert.doesNotMatch(view.evidence.emptyMessage ?? "", /연결|데이터베이스/);
  assert.match(view.evidence.emptyMessage ?? "", /똑같은 비중/);
});

test("the capture cohort is resolved to display copy, not a bare code", () => {
  assert.equal(toLocalForecastView(response({ captureCohort: "06" })).cohortLabel, "오전 6시 발표 기준");
  assert.equal(toLocalForecastView(response({ captureCohort: "18" })).cohortLabel, "오후 6시 발표 기준");
});

/**
 * Hours from 09:00 KST onward, one entry per hour, so buildForecastBlocks folds
 * them into 3-hour blocks starting at 09–12시. `probabilities` is read
 * positionally; null means the provider published no probability for that hour.
 */
function hours(probabilities: (number | null)[]): HourlyForecast[] {
  return probabilities.map((precipitationProbability, index) => ({
    time: `2026-08-14T${String(9 + index).padStart(2, "0")}:00:00+09:00`,
    temperature: 24,
    precipitationProbability,
    windSpeed: 3,
    humidity: 60,
    condition: precipitationProbability !== null && precipitationProbability >= 40 ? "rain" : "cloudy",
  }));
}

test("no provider publishing hourly leaves the timeline absent, not empty", () => {
  assert.equal(toLocalForecastView(response({ hourly: null })).timeline, null);
});

test("the timeline names the one provider it came from", () => {
  // The headline probability blends five providers but these blocks are one
  // provider's, so the page needs the name to avoid implying consensus.
  const view = toLocalForecastView(
    response({ hourly: { entries: hours([10, 10, 10]), sourceName: "Open-Meteo" } }),
  );
  assert.equal(view.timeline?.sourceName, "Open-Meteo");
  assert.equal(view.timeline?.blocks.length, 1);
});

test("rain onset is the first block that reaches the umbrella threshold", () => {
  const view = toLocalForecastView(
    response({
      hourly: {
        // 09–12 dry, 12–15 still under 40, 15–18 crosses it, 18–21 higher still.
        entries: hours([5, 8, 10, 20, 30, 35, 44, 60, 80, 90, 88, 70]),
        sourceName: "Open-Meteo",
      },
    }),
  );
  const blocks = view.timeline?.blocks ?? [];
  assert.equal(blocks.length, 4);
  assert.equal(blocks[2].precipMax, 80);
  // The third block is the first to reach 40, so onset must be its label and
  // not merely the wettest block's.
  assert.equal(view.timeline?.onsetLabel, blocks[2].label);
});

test("a day that never reaches the threshold reports no onset", () => {
  const view = toLocalForecastView(
    response({ hourly: { entries: hours([5, 10, 39, 12, 8, 3]), sourceName: "Open-Meteo" } }),
  );
  assert.notEqual(view.timeline, null);
  assert.equal(view.timeline?.onsetLabel, null);
});

test("hours with no published probability stay null instead of reading as 0%", () => {
  const view = toLocalForecastView(
    response({ hourly: { entries: hours([null, null, null, 55, 60, 65]), sourceName: "기상청" } }),
  );
  const blocks = view.timeline?.blocks ?? [];
  // A 0 here would tell someone it is certainly not raining, which nobody said.
  assert.equal(blocks[0].precipMax, null);
  assert.equal(blocks[1].precipMax, 65);
  assert.equal(view.timeline?.onsetLabel, blocks[1].label);
});
