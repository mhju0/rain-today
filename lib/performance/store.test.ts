import assert from "node:assert/strict";
import test from "node:test";
import { buildRecentPerformanceProfile } from "./performance.ts";
import { InMemoryPerformanceStore } from "./store.ts";
import type { ForecastCapture, ObservationStation, PrecipObservation } from "./types.ts";

const station: ObservationStation = {
  id: "108",
  name: "서울",
  network: "ASOS",
  latitude: 37.5714,
  longitude: 126.9658,
  elevationM: 85.7,
  activeFrom: "2026-01-01",
  activeTo: null,
};

const capture: ForecastCapture = {
  stationId: "108",
  targetDate: "2026-08-12",
  cohort: "06",
  capturedAt: "2026-08-11T06:10:00+09:00",
  providers: [
    { provider: "open-meteo", probability: 70, amountMm: 4 },
    { provider: "kma", probability: 50, amountMm: null },
  ],
  frozenBlend: {
    adaptiveProbability: 60,
    equalProbability: 60,
    influence: { "open-meteo": 0.5, kma: 0.5 },
  },
};

const observation: PrecipObservation = {
  stationId: "108",
  date: "2026-08-12",
  observedMm: 2.5,
  observedAt: "2026-08-13T06:10:00+09:00",
  source: "kma-asos",
};

test("performance store keeps captures immutable and round-trips profile inputs", async () => {
  const store = new InMemoryPerformanceStore();
  await store.initialize();
  await store.syncStations([station], "2026-08-13");

  assert.equal(await store.saveCapture(capture), "inserted");
  assert.equal(
    await store.saveCapture({
      ...capture,
      capturedAt: "2026-08-11T06:15:00+09:00",
      providers: [{ provider: "open-meteo", probability: 1, amountMm: 0 }],
    }),
    "existing",
  );
  await store.saveObservation(observation);

  const captures = await store.loadCaptures("108", "06");
  const observations = await store.loadObservations("108");
  assert.deepEqual(captures, [capture]);
  assert.deepEqual(observations, [observation]);
  assert.deepEqual(await store.listStations(), [station]);

  const profile = buildRecentPerformanceProfile({
    stationId: "108",
    cohort: "06",
    captures,
    observations,
    asOf: new Date("2026-08-13T12:00:00+09:00"),
  });
  assert.equal(profile.providers[0]?.sampleCount, 1);
});

test("corrected observations replace the same station-day without duplicating it", async () => {
  const store = new InMemoryPerformanceStore();
  await store.saveObservation(observation);
  await store.saveObservation({ ...observation, observedMm: 3.1 });

  assert.deepEqual(await store.loadObservations("108"), [
    { ...observation, observedMm: 3.1 },
  ]);
});

test("completed comparison reads return only the latest requested evidence", async () => {
  const store = new InMemoryPerformanceStore();
  for (const day of ["10", "11", "12"]) {
    const targetDate = `2026-08-${day}`;
    await store.saveCapture({ ...capture, targetDate });
    await store.saveObservation({ ...observation, date: targetDate });
  }

  const comparisons = await store.loadCompletedComparisons("108", "06", 2);

  assert.deepEqual(
    comparisons.map((comparison) => comparison.capture.targetDate),
    ["2026-08-11", "2026-08-12"],
  );
  assert.deepEqual(
    comparisons.map((comparison) => comparison.observation.date),
    ["2026-08-11", "2026-08-12"],
  );
});

test("station catalog sync closes stations missing from the next active catalog", async () => {
  const store = new InMemoryPerformanceStore();
  const retired: ObservationStation = {
    ...station,
    id: "999",
    name: "이전지점",
  };
  await store.syncStations([station, retired], "2026-08-13");
  await store.syncStations([station], "2026-08-14");

  assert.deepEqual(await store.listStations(), [
    station,
    { ...retired, activeTo: "2026-08-13" },
  ]);
});

test("station catalog sync rejects a severe active-catalog drop", async () => {
  const store = new InMemoryPerformanceStore();
  const nationwide = Array.from({ length: 25 }, (_, index): ObservationStation => ({
    ...station,
    id: String(100 + index),
    name: `관측소 ${index + 1}`,
  }));
  await store.syncStations(nationwide, "2026-08-13");

  await assert.rejects(
    () => store.syncStations(nationwide.slice(0, 5), "2026-08-14"),
    /catalog drop/,
  );
  assert.equal(
    (await store.listStations()).filter((candidate) => candidate.activeTo === null).length,
    25,
  );
});
