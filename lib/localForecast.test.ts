import assert from "node:assert/strict";
import test from "node:test";
import { createForecastLocation } from "./location.ts";
import { readLocalForecast, readPerformanceEvidenceFromStore } from "./localForecast.ts";
import { InMemoryPerformanceStore } from "./performance/store.ts";
import type { RecentPerformanceProfile } from "./performance/types.ts";
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

const profile: RecentPerformanceProfile = {
  stationId: "108",
  cohort: "18",
  generatedAt: "2026-08-13T09:10:00.000Z",
  windowStart: "2026-07-14",
  windowEnd: "2026-08-13",
  mode: "learned",
  reason: "learned",
  rampProgress: 1,
  providers: [],
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

test("local forecast targets the user's coordinate and applies only recent local influence", async () => {
  const location = createForecastLocation({
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
  assert.deepEqual(response.effectiveInfluence, { "open-meteo": 0.6, kma: 0.4 });
});

test("local forecast stays useful with equal influence when evidence is unavailable", async () => {
  const location = createForecastLocation({
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
  assert.deepEqual(response.effectiveInfluence, { "open-meteo": 0.5, kma: 0.5 });
  assert.equal(response.performance.reason, "database-not-configured");
});

test("equal fallback renormalizes each outlook day over providers available that day", async () => {
  const location = createForecastLocation({
    name: "현재 위치",
    latitude: 37.5665,
    longitude: 126.978,
  });
  const openMeteo = snapshot("open-meteo", 70, 2);
  openMeteo.daily.push({
    ...openMeteo.daily[0],
    date: "2026-08-15",
    precipitationProbability: 20,
    precipitationAmount: 0,
  });
  const weatherApi = snapshot("weather-api", 30, 1);
  weatherApi.daily = [{
    ...weatherApi.daily[0],
    date: "2026-08-15",
    precipitationProbability: 100,
    precipitationAmount: 8,
  }];

  const response = await readLocalForecast(
    { location, elevationM: null },
    {
      now: new Date("2026-08-13T05:30:00+09:00"),
      readForecasts: async () => [openMeteo, snapshot("kma", 30, null), weatherApi],
      readEvidence: async () => ({
        status: "unavailable",
        reason: "database-not-configured",
        station: null,
        profile: null,
      }),
    },
  );

  assert.equal(response.outlook[1]?.precipitationProbability, 60);
});

test("active weighting gives a newly available provider the policy floor instead of zero", async () => {
  const location = createForecastLocation({
    name: "부산 수영구",
    latitude: 35.1532,
    longitude: 129.1187,
  });
  const response = await readLocalForecast(
    { location, elevationM: 12 },
    {
      now: new Date("2026-08-13T18:20:00+09:00"),
      readForecasts: async () => [
        snapshot("open-meteo", 80, 5),
        snapshot("kma", 50, null),
        snapshot("weather-api", 100, 9),
      ],
      readEvidence: async () => ({
        status: "active",
        reason: "eligible-station",
        station: { id: "159", name: "부산", distanceKm: 6.2 },
        profile,
      }),
    },
  );

  assert.ok(response.effectiveInfluence["weather-api"] > 0);
  assert.ok(response.effectiveInfluence["weather-api"] < response.effectiveInfluence.kma);
  assert.ok((response.recommendation.precipitationProbability ?? 0) > 68);
});

test("local forecast starts provider and evidence reads concurrently", async () => {
  const location = createForecastLocation({
    name: "서울",
    latitude: 37.5665,
    longitude: 126.978,
  });
  let releaseForecasts!: () => void;
  const forecastsReady = new Promise<void>((resolve) => {
    releaseForecasts = resolve;
  });
  let evidenceStarted = false;

  const pending = readLocalForecast(
    { location, elevationM: null },
    {
      now: new Date("2026-08-13T18:20:00+09:00"),
      readForecasts: async () => {
        await forecastsReady;
        return [snapshot("open-meteo", 70, 2)];
      },
      readEvidence: async () => {
        evidenceStarted = true;
        return {
          status: "unavailable",
          reason: "database-not-configured",
          station: null,
          profile: null,
        };
      },
    },
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  const startedBeforeProvidersFinished = evidenceStarted;
  releaseForecasts();
  await pending;
  assert.equal(startedBeforeProvidersFinished, true);
});

test("runtime evidence reads do not run schema setup or close the shared store", async () => {
  class TrackingStore extends InMemoryPerformanceStore {
    initializeCalls = 0;
    closeCalls = 0;
    comparisonLimits: number[] = [];

    override async initialize(): Promise<void> {
      this.initializeCalls += 1;
    }

    override async close(): Promise<void> {
      this.closeCalls += 1;
    }

    override async loadCompletedComparisons(
      stationId: string,
      cohort: "06" | "18",
      limit: number,
    ) {
      this.comparisonLimits.push(limit);
      return super.loadCompletedComparisons(stationId, cohort, limit);
    }
  }

  const store = new TrackingStore();
  await store.syncStations([{
    id: "108",
    name: "서울",
    network: "ASOS",
    latitude: 37.5714,
    longitude: 126.9658,
    elevationM: 85.7,
    activeFrom: "2026-01-01",
    activeTo: null,
  }], "2026-08-13");

  const evidence = await readPerformanceEvidenceFromStore(
    store,
    createForecastLocation({ name: "서울", latitude: 37.5665, longitude: 126.978 }),
    null,
    "18",
    new Date("2026-08-13T18:20:00+09:00"),
  );

  assert.equal(evidence.status, "collecting");
  assert.equal(store.initializeCalls, 0);
  assert.equal(store.closeCalls, 0);
  assert.deepEqual(store.comparisonLimits, [60]);
});

test("next-day performance influence does not leak into later outlook horizons", async () => {
  const location = createForecastLocation({
    name: "서울",
    latitude: 37.5665,
    longitude: 126.978,
  });
  const openMeteo = snapshot("open-meteo", 80, 5);
  openMeteo.daily.push({
    ...openMeteo.daily[0],
    date: "2026-08-15",
    precipitationProbability: 100,
  });
  const kma = snapshot("kma", 50, null);
  kma.daily.push({
    ...kma.daily[0],
    date: "2026-08-15",
    precipitationProbability: 0,
  });

  const response = await readLocalForecast(
    { location, elevationM: null },
    {
      now: new Date("2026-08-13T18:20:00+09:00"),
      readForecasts: async () => [openMeteo, kma],
      readEvidence: async () => ({
        status: "active",
        reason: "eligible-station",
        station: { id: "108", name: "서울", distanceKm: 1.2 },
        profile,
      }),
    },
  );

  assert.equal(response.recommendation.precipitationProbability, 68);
  assert.equal(response.outlook[1]?.precipitationProbability, 50);
});
