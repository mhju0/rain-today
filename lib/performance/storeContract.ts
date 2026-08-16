import assert from "node:assert/strict";
import test from "node:test";
import type { PerformanceStore } from "./store.ts";
import type {
  CaptureCohort,
  ForecastCapture,
  ObservationStation,
  PrecipObservation,
  PrecipProviderId,
} from "./types.ts";

/**
 * One executable contract for every PerformanceStore adapter. The in-memory and
 * PostgreSQL adapters re-implement bounded per-provider selection and station
 * retirement in different languages; without a shared suite the two can diverge
 * silently, because only the in-memory one is reachable from a unit test.
 */

const COHORT: CaptureCohort = "06";

function station(id: string, overrides: Partial<ObservationStation> = {}): ObservationStation {
  return {
    id,
    name: `station-${id}`,
    network: "ASOS",
    latitude: 37.5,
    longitude: 127,
    elevationM: 30,
    activeFrom: "2026-01-01",
    activeTo: null,
    ...overrides,
  };
}

function capture(
  stationId: string,
  targetDate: string,
  providers: Partial<Record<PrecipProviderId, number | null>>,
): ForecastCapture {
  const entries = Object.entries(providers) as [PrecipProviderId, number | null][];
  return {
    stationId,
    targetDate,
    cohort: COHORT,
    capturedAt: `${targetDate}T21:10:00.000Z`,
    providers: entries.map(([provider, probability]) => ({
      provider,
      probability,
      amountMm: probability === null ? null : 1,
    })),
    frozenBlend: {
      adaptiveProbability: 50,
      equalProbability: 50,
      influence: Object.fromEntries(entries.map(([provider]) => [provider, 1 / entries.length])),
    },
  };
}

function observation(stationId: string, date: string, observedMm: number): PrecipObservation {
  return {
    stationId,
    date,
    observedMm,
    observedAt: `${date}T15:00:00.000Z`,
    source: "kma-asos",
  };
}

/**
 * Register the contract against one adapter. `createStore` must return an empty,
 * isolated store; the suite writes to it.
 */
export function runPerformanceStoreContract(
  adapterName: string,
  createStore: () => Promise<PerformanceStore>,
): void {
  const withStore = async (body: (store: PerformanceStore) => Promise<void>): Promise<void> => {
    const store = await createStore();
    await store.initialize();
    try {
      await body(store);
    } finally {
      await store.close();
    }
  };

  test(`${adapterName} reports whether a capture was newly inserted`, async () => {
    await withStore(async (store) => {
      const first = capture("108", "2026-03-02", { "open-meteo": 60 });
      assert.equal(await store.saveCapture(first), "inserted");
      assert.equal(await store.saveCapture(first), "existing");
    });
  });

  test(`${adapterName} pairs a capture with its later observation only`, async () => {
    await withStore(async (store) => {
      await store.saveCapture(capture("108", "2026-03-02", { "open-meteo": 60 }));
      await store.saveCapture(capture("108", "2026-03-03", { "open-meteo": 40 }));
      await store.saveObservation(observation("108", "2026-03-02", 3.5));

      const comparisons = await store.loadCompletedComparisons("108", COHORT, 10);

      assert.equal(comparisons.length, 1);
      assert.equal(comparisons[0].capture.targetDate, "2026-03-02");
      assert.equal(comparisons[0].observation.observedMm, 3.5);
    });
  });

  test(`${adapterName} never returns another station's or cohort's evidence`, async () => {
    await withStore(async (store) => {
      await store.saveCapture(capture("108", "2026-03-02", { "open-meteo": 60 }));
      await store.saveCapture({
        ...capture("112", "2026-03-02", { "open-meteo": 60 }),
      });
      await store.saveCapture({
        ...capture("108", "2026-03-02", { "open-meteo": 60 }),
        cohort: "18",
      });
      await store.saveObservation(observation("108", "2026-03-02", 1));
      await store.saveObservation(observation("112", "2026-03-02", 1));

      const comparisons = await store.loadCompletedComparisons("108", COHORT, 10);

      assert.equal(comparisons.length, 1);
      assert.equal(comparisons[0].capture.stationId, "108");
      assert.equal(comparisons[0].capture.cohort, COHORT);
    });
  });

  test(`${adapterName} keeps an intermittent provider's maturity inside the bound`, async () => {
    await withStore(async (store) => {
      // open-meteo reports every day; kma reports only on the two oldest days.
      // A naive newest-N read would return three open-meteo rows and no kma
      // evidence at all, retiring a provider that simply reports less often.
      const dates = ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"];
      for (const date of dates) {
        await store.saveCapture(
          capture(
            "108",
            date,
            date <= "2026-03-02"
              ? { "open-meteo": 60, kma: 55 }
              : { "open-meteo": 60 },
          ),
        );
        await store.saveObservation(observation("108", date, 0));
      }

      const comparisons = await store.loadCompletedComparisons("108", COHORT, 3);
      const kmaRows = comparisons.filter((comparison) =>
        comparison.capture.providers.some(
          (forecast) => forecast.provider === "kma" && forecast.probability !== null,
        ),
      );

      assert.equal(kmaRows.length, 2, "bounded read dropped an intermittent provider");
      assert.ok(
        comparisons.some((comparison) => comparison.capture.targetDate === "2026-03-05"),
        "bounded read dropped the newest evidence",
      );
    });
  });

  test(`${adapterName} rejects an unusable comparison limit`, async () => {
    await withStore(async (store) => {
      await assert.rejects(() => store.loadCompletedComparisons("108", COHORT, 0), RangeError);
      await assert.rejects(() => store.loadCompletedComparisons("108", COHORT, 1.5), RangeError);
    });
  });

  test(`${adapterName} retires a station the day before the new catalog date`, async () => {
    await withStore(async (store) => {
      await store.syncStations([station("108"), station("112")], "2026-03-01");
      await store.syncStations([station("108")], "2026-03-10");

      const stations = await store.listStations();
      const retired = stations.find((entry) => entry.id === "112");
      const retained = stations.find((entry) => entry.id === "108");

      assert.equal(retired?.activeTo, "2026-03-09");
      assert.equal(retained?.activeTo, null);
    });
  });

  test(`${adapterName} preserves the original activeFrom across a re-sync`, async () => {
    await withStore(async (store) => {
      await store.syncStations([station("108", { activeFrom: "2026-01-01" })], "2026-03-01");
      await store.syncStations([station("108", { activeFrom: "2026-03-10" })], "2026-03-10");

      const stations = await store.listStations();

      assert.equal(stations[0].activeFrom, "2026-01-01");
    });
  });

  test(`${adapterName} refuses a catalog sync that drops too many active stations`, async () => {
    await withStore(async (store) => {
      const full = Array.from({ length: 25 }, (_, index) => station(String(100 + index)));
      await store.syncStations(full, "2026-03-01");

      await assert.rejects(
        () => store.syncStations(full.slice(0, 5), "2026-03-10"),
        /retirement safety threshold/,
      );

      const stations = await store.listStations();
      assert.equal(stations.filter((entry) => entry.activeTo === null).length, 25);
    });
  });
}
