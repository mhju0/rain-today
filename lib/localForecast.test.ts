import assert from "node:assert/strict";
import test from "node:test";
import { createKoreanLocation } from "./location.ts";
import { readLocalForecast } from "./localForecast.ts";
import type { LocalPerformanceProfile } from "./performance/types.ts";
import type { ProviderSnapshot } from "./types.ts";

function snapshot(
  id: ProviderSnapshot["id"],
  probability: number | null,
  amountMm: number | null,
): ProviderSnapshot {
  return {
    id,
    status: {
      id,
      name: id,
      availability: "ok",
      message: "ok",
      missingEnvVars: [],
      lastUpdated: "2026-08-13T18:00:00+09:00",
      fromCache: false,
    },
    current: null,
    hourly: [],
    daily: [{
      date: "2026-08-14",
      temperatureMax: 31,
      temperatureMin: 24,
      precipitationProbability: probability,
      precipitationAmount: amountMm,
      condition: "rain",
      sunrise: null,
      sunset: null,
    }],
  };
}

const profile: LocalPerformanceProfile = {
  stationId: "108",
  cohort: "18",
  generatedAt: "2026-08-13T09:10:00.000Z",
  windowStart: "2026-07-14",
  windowEnd: "2026-08-13",
  mode: "learned",
  reason: "learned",
  confidence: 1,
  providers: [],
  effectiveWeights: { "open-meteo": 0.6, kma: 0.4 },
  benchmark: {
    sampleCount: 30,
    adaptiveBrier: 0.14,
    equalBrier: 0.18,
    openMeteoBrier: 0.12,
    kmaBrier: 0.22,
    status: "passing",
  },
};

test("local forecast targets the user's coordinate and applies only recent local influence", async () => {
  const location = createKoreanLocation({
    name: "부산 수영구",
    latitude: 35.1532,
    longitude: 129.1187,
  });
  const seen: typeof location[] = [];
  const response = await readLocalForecast(
    { location, elevationM: 12 },
    {
      now: new Date("2026-08-13T18:20:00+09:00"),
      readForecasts: async (target) => {
        seen.push(target);
        return [snapshot("open-meteo", 80, 5), snapshot("kma", 50, null)];
      },
      readEvidence: async () => ({
        status: "active",
        reason: "eligible-station",
        station: { id: "159", name: "부산", distanceKm: 6.2 },
        profile,
      }),
    },
  );

  assert.equal(seen[0]?.latitude, 35.1532);
  assert.equal(response.location.name, "부산 수영구");
  assert.equal(response.targetDate, "2026-08-14");
  assert.equal(response.recommendation.precipitationProbability, 68);
  assert.equal(response.recommendation.precipitationAmountMm, 5);
  assert.deepEqual(response.outlook, [{
    date: "2026-08-14",
    precipitationProbability: 68,
    precipitationAmountMm: 5,
    temperatureMax: 31,
    temperatureMin: 24,
    condition: "rain",
  }]);
  assert.equal(response.performance.status, "active");
  assert.equal(response.performance.station?.distanceKm, 6.2);
  assert.deepEqual(response.providerInfluence, { "open-meteo": 0.6, kma: 0.4 });
});

test("local forecast stays useful with equal influence when evidence is unavailable", async () => {
  const location = createKoreanLocation({
    name: "현재 위치",
    latitude: 37.5665,
    longitude: 126.978,
  });
  const response = await readLocalForecast(
    { location, elevationM: null },
    {
      now: new Date("2026-08-13T05:30:00+09:00"),
      readForecasts: async () => [snapshot("open-meteo", 70, 2), snapshot("kma", 30, null)],
      readEvidence: async () => ({
        status: "unavailable",
        reason: "database-not-configured",
        station: null,
        profile: null,
      }),
    },
  );

  assert.equal(response.captureCohort, "18");
  assert.equal(response.recommendation.precipitationProbability, 50);
  assert.deepEqual(response.providerInfluence, { "open-meteo": 0.5, kma: 0.5 });
  assert.equal(response.performance.reason, "database-not-configured");
});
