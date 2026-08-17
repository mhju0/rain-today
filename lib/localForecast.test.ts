import assert from "node:assert/strict";
import test from "node:test";
import { createForecastLocation } from "./location.ts";
import { readLocalForecast, readPerformanceEvidenceFromStore } from "./localForecast.ts";
import { captureStationForecast } from "./performance/capture.ts";
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

test("the frozen capture blend and the served blend agree on one station's evidence", async () => {
  // The Prospective Benchmark scores the probability frozen at capture time
  // against the blend served to users. If those two are derived separately they
  // can drift apart while every isolated test still passes, and the benchmark
  // silently stops measuring what it claims to.
  const now = new Date("2026-08-13T18:20:00+09:00");
  const store = new InMemoryPerformanceStore();
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

  // 60 completed comparisons in which open-meteo is sharp and kma is not, and
  // the adaptive blend prospectively beat equal weighting, so influence is
  // actually learned rather than trivially equal.
  for (let daysAgo = 60; daysAgo >= 1; daysAgo -= 1) {
    const targetDate = new Date(now.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    const wet = daysAgo % 2 === 0;
    await store.saveCapture({
      stationId: "108",
      targetDate,
      cohort: "18",
      capturedAt: `${targetDate}T18:00:00+09:00`,
      providers: [
        { provider: "open-meteo", probability: wet ? 90 : 10, amountMm: null },
        { provider: "kma", probability: wet ? 30 : 70, amountMm: null },
      ],
      frozenBlend: {
        adaptiveProbability: wet ? 80 : 20,
        equalProbability: 50,
        influence: { "open-meteo": 0.5, kma: 0.5 },
      },
    });
    await store.saveObservation({
      stationId: "108",
      date: targetDate,
      observedMm: wet ? 10 : 0,
      observedAt: `${targetDate}T23:59:00+09:00`,
      source: "kma-asos",
    });
  }

  const readForecasts = async () => [snapshot("open-meteo", 80, 5), snapshot("kma", 50, null)];
  const captured = await captureStationForecast({
    station: (await store.listStations())[0],
    cohort: "18",
    now,
    store,
    readForecasts,
  });
  const served = await readLocalForecast(
    {
      location: createForecastLocation({
        name: "서울",
        latitude: 37.5714,
        longitude: 126.9658,
      }),
      elevationM: 85.7,
    },
    {
      now,
      readForecasts,
      readEvidence: async (location, elevationM, cohort, at) =>
        readPerformanceEvidenceFromStore(store, location, elevationM, cohort, at),
    },
  );

  assert.equal(served.performance.status, "active", "evidence must be learning for this to bite");
  assert.notDeepEqual(
    served.effectiveInfluence,
    { "open-meteo": 0.5, kma: 0.5 },
    "influence must be learned, not equal, or agreement proves nothing",
  );
  assert.deepEqual(captured.capture?.frozenBlend.influence, served.effectiveInfluence);
  assert.equal(
    captured.capture?.frozenBlend.adaptiveProbability,
    served.recommendation.precipitationProbability,
  );
});

test("today is served on equal weighting even while the profile is active", async () => {
  const location = createForecastLocation({
    name: "서울",
    latitude: 37.5665,
    longitude: 126.978,
  });
  // Same two providers for today as for the target date, so any difference in
  // the served numbers can only come from the weighting.
  const openMeteo = snapshot("open-meteo", 80, 5);
  openMeteo.daily.unshift({ ...openMeteo.daily[0], date: "2026-08-13" });
  const kma = snapshot("kma", 50, null);
  kma.daily.unshift({ ...kma.daily[0], date: "2026-08-13" });

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

  assert.equal(response.today?.date, "2026-08-13");
  // The Recent Performance Profile scores next-day forecasts only. 68 is the
  // learned blend (0.6/0.4); 65 is the plain average. Today must be 65, or the
  // page would claim an accuracy nothing has measured for this horizon.
  assert.equal(response.recommendation.precipitationProbability, 68);
  assert.equal(response.today?.precipitationProbability, 65);
});

test("today is null rather than invented when no provider still publishes it", async () => {
  const location = createForecastLocation({
    name: "서울",
    latitude: 37.5665,
    longitude: 126.978,
  });

  const response = await readLocalForecast(
    { location, elevationM: null },
    {
      now: new Date("2026-08-13T18:20:00+09:00"),
      readForecasts: async () => [snapshot("open-meteo", 80, 5)],
      readEvidence: async () => ({
        status: "unavailable",
        reason: "database-not-configured",
        station: null,
        profile: null,
      }),
    },
  );

  assert.equal(response.today, null);
  assert.equal(response.recommendation.precipitationProbability, 80);
});
