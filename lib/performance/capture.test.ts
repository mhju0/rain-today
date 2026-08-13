import assert from "node:assert/strict";
import test from "node:test";
import type { KoreanLocation } from "../location.ts";
import type { ProviderSnapshot } from "../types.ts";
import { captureStationForecast } from "./capture.ts";
import { InMemoryPerformanceStore } from "./store.ts";
import type { ObservationStation } from "./types.ts";

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

function snapshot(
  id: ProviderSnapshot["id"],
  probability: number | null,
  amountMm?: number | null,
): ProviderSnapshot {
  return {
    id,
    status: {
      id,
      name: id,
      availability: "ok",
      message: "ok",
      missingEnvVars: [],
      lastUpdated: "2026-08-13T06:00:00+09:00",
      fromCache: false,
    },
    current: null,
    hourly: [],
    daily: [{
      date: "2026-08-14",
      temperatureMax: 30,
      temperatureMin: 24,
      precipitationProbability: probability,
      precipitationAmount: amountMm,
      condition: "rain",
      sunrise: null,
      sunset: null,
    }],
  };
}

test("fixed-cohort capture freezes the serving blend and is idempotent", async () => {
  const store = new InMemoryPerformanceStore();
  await store.syncStations([station], "2026-08-13");
  const seenLocations: KoreanLocation[] = [];
  const readForecasts = async (location: KoreanLocation): Promise<ProviderSnapshot[]> => {
    seenLocations.push(location);
    return [
      snapshot("open-meteo", 80, 7),
      snapshot("kma", 40),
      snapshot("airkorea", null),
    ];
  };

  const first = await captureStationForecast({
    station,
    cohort: "06",
    now: new Date("2026-08-13T06:10:00+09:00"),
    store,
    readForecasts,
  });
  const retry = await captureStationForecast({
    station,
    cohort: "06",
    now: new Date("2026-08-13T06:20:00+09:00"),
    store,
    readForecasts,
  });

  assert.equal(first.status, "inserted");
  assert.equal(retry.status, "existing");
  assert.equal(first.capture?.targetDate, "2026-08-14");
  assert.equal(first.capture?.frozenBlend.equalProbability, 60);
  assert.equal(first.capture?.frozenBlend.adaptiveProbability, 60);
  assert.deepEqual(first.capture?.providers, [
    { provider: "open-meteo", probability: 80, amountMm: 7 },
    { provider: "kma", probability: 40, amountMm: null },
  ]);
  assert.equal(seenLocations[0]?.latitude, station.latitude);
  assert.equal((await store.loadCaptures("108", "06")).length, 1);
});

test("capture skips a station when no provider has a valid next-day probability", async () => {
  const store = new InMemoryPerformanceStore();
  const result = await captureStationForecast({
    station,
    cohort: "18",
    now: new Date("2026-08-13T18:10:00+09:00"),
    store,
    readForecasts: async () => [snapshot("open-meteo", null)],
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "no-next-day-probability");
});

test("insufficient historical evidence keeps all current providers equally weighted", async () => {
  const store = new InMemoryPerformanceStore();
  await store.syncStations([station], "2026-08-13");
  await store.saveCapture({
    stationId: station.id,
    targetDate: "2026-08-01",
    cohort: "06",
    capturedAt: "2026-07-31T06:10:00+09:00",
    providers: [{ provider: "open-meteo", probability: 40, amountMm: null }],
    frozenBlend: {
      adaptiveProbability: 40,
      equalProbability: 40,
      influence: { "open-meteo": 1 },
    },
  });
  await store.saveObservation({
    stationId: station.id,
    date: "2026-08-01",
    observedMm: 0,
    observedAt: "2026-08-02T06:10:00+09:00",
    source: "kma-asos",
  });

  const result = await captureStationForecast({
    station,
    cohort: "06",
    now: new Date("2026-08-13T06:10:00+09:00"),
    store,
    readForecasts: async () => [snapshot("open-meteo", 80), snapshot("kma", 40)],
  });

  assert.deepEqual(result.capture?.frozenBlend.influence, { "open-meteo": 0.5, kma: 0.5 });
});
