import assert from "node:assert/strict";
import test from "node:test";
import { chunkMonths, runSeedBackfill } from "./backfill.ts";
import { InMemoryPerformanceStore } from "./store.ts";
import type { ObservationStation, SeedComparison } from "./types.ts";

const NOW = new Date("2026-08-18T00:00:00.000Z");

function station(id: string): ObservationStation {
  return {
    id,
    name: `station-${id}`,
    network: "ASOS",
    latitude: 37.5,
    longitude: 127,
    elevationM: 30,
    activeFrom: "2020-01-01",
    activeTo: null,
  };
}

function comparison(stationId: string, targetDate: string): SeedComparison {
  return {
    stationId,
    targetDate,
    providers: [{ provider: "kma", amountMm: 1 }],
    observedMm: 2,
    builtAt: NOW.toISOString(),
  };
}

async function storeWith(stations: readonly ObservationStation[]): Promise<InMemoryPerformanceStore> {
  const store = new InMemoryPerformanceStore();
  await store.initialize();
  await store.syncStations(stations, "2026-08-18");
  return store;
}

test("a range is split on calendar month boundaries", () => {
  assert.deepEqual(chunkMonths("2025-06-15", "2025-08-03"), [
    ["2025-06-15", "2025-06-30"],
    ["2025-07-01", "2025-07-31"],
    ["2025-08-01", "2025-08-03"],
  ]);
});

test("a single-day range is one window", () => {
  assert.deepEqual(chunkMonths("2025-06-15", "2025-06-15"), [["2025-06-15", "2025-06-15"]]);
});

test("a reversed range produces no windows", async () => {
  assert.deepEqual(chunkMonths("2025-08-01", "2025-06-01"), []);
  await assert.rejects(
    () =>
      runSeedBackfill({
        stations: [station("108")],
        startDate: "2025-08-01",
        endDate: "2025-06-01",
        now: NOW,
        store: new InMemoryPerformanceStore(),
      }),
    RangeError,
  );
});

test("every station and window is visited exactly once", async () => {
  const store = await storeWith([station("108"), station("112")]);
  const seen: string[] = [];

  const result = await runSeedBackfill({
    stations: [station("108"), station("112")],
    startDate: "2025-06-01",
    endDate: "2025-07-31",
    now: NOW,
    store,
    concurrency: 1,
    buildComparisons: async ({ station: target, startDate }) => {
      seen.push(`${target.id}:${startDate}`);
      return [comparison(target.id, startDate)];
    },
  });

  assert.deepEqual(seen, [
    "108:2025-06-01",
    "108:2025-07-01",
    "112:2025-06-01",
    "112:2025-07-01",
  ]);
  assert.equal(result.comparisonsStored, 4);
  assert.equal(result.windowCount, 2);
});

test("a failed window is recorded and does not abort the run", async () => {
  const store = await storeWith([station("108"), station("112")]);

  const result = await runSeedBackfill({
    stations: [station("108"), station("112")],
    startDate: "2025-06-01",
    endDate: "2025-07-31",
    now: NOW,
    store,
    concurrency: 1,
    buildComparisons: async ({ station: target, startDate }) => {
      if (target.id === "108" && startDate === "2025-06-01") throw new Error("archive timeout");
      return [comparison(target.id, startDate)];
    },
  });

  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].stationId, "108");
  assert.equal(result.failures[0].window, "2025-06-01..2025-06-30");
  assert.equal(result.comparisonsStored, 3, "the other windows still stored");
});

test("re-running stores nothing new", async () => {
  const stations = [station("108")];
  const store = await storeWith(stations);
  const request = {
    stations,
    startDate: "2025-06-01",
    endDate: "2025-06-30",
    now: NOW,
    store,
    buildComparisons: async ({ startDate }: { startDate: string }) => [
      comparison("108", startDate),
    ],
  };

  const first = await runSeedBackfill(request as never);
  const second = await runSeedBackfill(request as never);

  assert.equal(first.comparisonsStored, 1);
  assert.equal(second.comparisonsStored, 0, "backfill must be idempotent");
  assert.equal(second.comparisonsBuilt, 1, "it still rebuilt, it just stored nothing new");
});

test("a station that yields no comparisons is not an error", async () => {
  const store = await storeWith([station("108")]);

  const result = await runSeedBackfill({
    stations: [station("108")],
    startDate: "2025-06-01",
    endDate: "2025-06-30",
    now: NOW,
    store,
    buildComparisons: async () => [],
  });

  assert.equal(result.comparisonsStored, 0);
  assert.deepEqual(result.failures, []);
});
