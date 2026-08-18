import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSeedRange,
  buildSeedComparisons,
  joinSeedComparisons,
  MAX_SEED_RANGE_DAYS,
  parseArchivedDayAheadForecasts,
  parseAsosDailyRange,
  SEED_PROVIDER_MODELS,
  SEED_PROVIDERS,
  seedObservation,
  sumHourlyByDate,
} from "./seed.ts";
import type { ObservationStation, SeedProviderForecast } from "./types.ts";

const STATION: ObservationStation = {
  id: "108",
  name: "서울",
  network: "ASOS",
  latitude: 37.5714,
  longitude: 126.9658,
  elevationM: 30,
  activeFrom: "2020-01-01",
  activeTo: null,
};

function hourly(date: string, values: (number | null)[]): string[] {
  return values.map((_, index) => `${date}T${String(index).padStart(2, "0")}:00`);
}

test("a provider without an honest archive proxy is never seeded", () => {
  assert.ok(!SEED_PROVIDERS.includes("weather-api"));
  assert.equal(SEED_PROVIDER_MODELS["weather-api"], undefined);
  // Every seeded provider must name a model; an unnamed proxy is a fabrication.
  for (const provider of SEED_PROVIDERS) {
    assert.equal(typeof SEED_PROVIDER_MODELS[provider], "string");
  }
});

test("a fully null day is missing data, not a forecast of zero", () => {
  const times = [...hourly("2025-08-01", Array(24).fill(0)), ...hourly("2025-08-02", Array(24).fill(0))];
  const values = [...Array(24).fill(null), ...Array(24).fill(0)];
  const totals = sumHourlyByDate(times, values);

  assert.equal(totals.get("2025-08-01"), null, "no archived run must stay null");
  assert.equal(totals.get("2025-08-02"), 0, "a measured dry day must stay 0");
});

test("hourly precipitation sums into an Asia/Seoul daily total", () => {
  const values = Array(24).fill(0);
  values[3] = 1.25;
  values[14] = 2.5;
  const totals = sumHourlyByDate(hourly("2025-08-03", values), values);

  assert.equal(totals.get("2025-08-03"), 3.75);
});

test("archived payloads are reshaped per date and provider", () => {
  const times = hourly("2025-08-04", Array(24).fill(0));
  const rain = Array(24).fill(0);
  rain[6] = 9.2;
  const parsed = parseArchivedDayAheadForecasts({
    hourly: {
      time: times,
      precipitation_previous_day1_best_match: Array(24).fill(0),
      precipitation_previous_day1_ecmwf_ifs025: rain,
      precipitation_previous_day1_kma_seamless: Array(24).fill(null),
      precipitation_previous_day1_gfs_seamless: Array(24).fill(0),
    },
  });

  const day = parsed.get("2025-08-04")!;
  const byProvider = new Map(day.map((forecast) => [forecast.provider, forecast.amountMm]));
  assert.equal(byProvider.get("met-norway"), 9.2);
  assert.equal(byProvider.get("open-meteo"), 0);
  assert.equal(byProvider.get("kma"), null, "a model with no run must not read as dry");
});

test("a malformed archive payload yields nothing rather than throwing", () => {
  assert.equal(parseArchivedDayAheadForecasts(null).size, 0);
  assert.equal(parseArchivedDayAheadForecasts({ hourly: { time: "nope" } }).size, 0);
});

test("a blank ASOS daily total is a measured dry day", () => {
  const observed = parseAsosDailyRange({
    response: {
      body: {
        items: {
          item: [
            { tm: "2025-08-01", sumRn: "0.0" },
            { tm: "2025-08-02", sumRn: "" },
            { tm: "2025-08-03", sumRn: "1.3" },
            { tm: "not-a-date", sumRn: "5.0" },
          ],
        },
      },
    },
  });

  assert.equal(observed.get("2025-08-02"), 0);
  assert.equal(observed.get("2025-08-03"), 1.3);
  assert.equal(observed.size, 3, "an unparseable row must be dropped");
});

test("a single-row ASOS response is accepted", () => {
  const observed = parseAsosDailyRange({
    response: { body: { items: { item: { tm: "2025-08-01", sumRn: "2.0" } } } },
  });
  assert.deepEqual([...observed], [["2025-08-01", 2]]);
});

test("a seed range is bounded before it reaches a provider", () => {
  assert.throws(() => assertSeedRange("2025-08-10", "2025-08-01"), RangeError);
  assert.throws(() => assertSeedRange("2025-8-1", "2025-08-01"), RangeError);
  assert.throws(() => assertSeedRange("2024-01-01", "2025-06-01"), RangeError);
  assert.doesNotThrow(() => assertSeedRange("2025-08-01", "2025-08-01"));
  const end = new Date(Date.parse("2025-01-01T00:00:00.000Z") + (MAX_SEED_RANGE_DAYS - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  assert.doesNotThrow(() => assertSeedRange("2025-01-01", end));
});

test("a date without an observation or without any forecast is dropped", () => {
  const forecasts = new Map<string, SeedProviderForecast[]>([
    ["2025-08-01", [{ provider: "open-meteo", amountMm: 1 }]],
    ["2025-08-02", [{ provider: "open-meteo", amountMm: null }]],
    ["2025-08-04", [{ provider: "open-meteo", amountMm: 3 }]],
  ]);
  const observations = new Map([
    ["2025-08-01", 0.5],
    ["2025-08-02", 0],
    ["2025-08-03", 2],
  ]);

  const joined = joinSeedComparisons("108", forecasts, observations, new Date("2026-08-18T00:00:00Z"));

  assert.deepEqual(joined.map((row) => row.targetDate), ["2025-08-01"]);
  assert.equal(joined[0].observedMm, 0.5);
  assert.equal(joined[0].providers.length, 1);
});

test("a seed comparison never carries a probability or a cohort", () => {
  const joined = joinSeedComparisons(
    "108",
    new Map([["2025-08-01", [{ provider: "kma", amountMm: 2 }]]]),
    new Map([["2025-08-01", 1]]),
    new Date("2026-08-18T00:00:00Z"),
  );

  const row = joined[0] as unknown as Record<string, unknown>;
  assert.ok(!("cohort" in row), "seed evidence is not a cohort capture");
  assert.ok(!("frozenBlend" in row), "seed evidence was never frozen at capture time");
  for (const forecast of joined[0].providers) {
    assert.ok(
      !("probability" in (forecast as unknown as Record<string, unknown>)),
      "archives publish no probability; seeding must not invent one",
    );
  }
});

test("no observation window means no archive request at all", async () => {
  let archiveCalls = 0;
  const comparisons = await buildSeedComparisons({
    station: STATION,
    startDate: "2025-08-01",
    endDate: "2025-08-02",
    now: new Date("2026-08-18T00:00:00Z"),
    fetchObservations: async () => new Map(),
    fetchArchive: async () => {
      archiveCalls += 1;
      return new Map();
    },
  });

  assert.deepEqual(comparisons, []);
  assert.equal(archiveCalls, 0, "ground truth gates the archive call");
});

test("a station's seed comparisons pair archive and observation by date", async () => {
  const comparisons = await buildSeedComparisons({
    station: STATION,
    startDate: "2025-08-01",
    endDate: "2025-08-02",
    now: new Date("2026-08-18T00:00:00Z"),
    fetchObservations: async (stationId, startDate, endDate) => {
      assert.equal(stationId, "108");
      assert.equal(startDate, "2025-08-01");
      assert.equal(endDate, "2025-08-02");
      return new Map([["2025-08-01", 1.3], ["2025-08-02", 0]]);
    },
    fetchArchive: async (range) => {
      assert.equal(range.latitude, STATION.latitude);
      return new Map([
        ["2025-08-01", [{ provider: "kma", amountMm: 0.4 }] as SeedProviderForecast[]],
        ["2025-08-02", [{ provider: "kma", amountMm: 0 }] as SeedProviderForecast[]],
      ]);
    },
  });

  assert.equal(comparisons.length, 2);
  assert.equal(comparisons[0].providers[0].amountMm, 0.4);
  assert.equal(comparisons[0].observedMm, 1.3);
});

test("a seed observation adapts to the shared observation record", () => {
  const observation = seedObservation({
    stationId: "108",
    targetDate: "2025-08-01",
    providers: [{ provider: "kma", amountMm: 1 }],
    observedMm: 1.3,
    builtAt: "2026-08-18T00:00:00.000Z",
  });

  assert.deepEqual(observation, {
    stationId: "108",
    date: "2025-08-01",
    observedMm: 1.3,
    observedAt: "2026-08-18T00:00:00.000Z",
    source: "kma-asos",
  });
});
