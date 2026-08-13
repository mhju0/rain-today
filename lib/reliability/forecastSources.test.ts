import { test } from "node:test";
import assert from "node:assert/strict";
import { clearCache } from "../cache.ts";
import { createKoreanLocation } from "../location.ts";
import type { WeatherProvider } from "../providers/base.ts";
import type { DailyForecast, ProviderId, ProviderSnapshot, WeatherProviderStatus } from "../types.ts";
import { boundedSourceTimeout, collectForecastSources } from "./forecastSources.ts";

test("source timeouts are clamped to a finite operational range", () => {
  assert.equal(boundedSourceTimeout(Number.NaN, 4_000), 4_000);
  assert.equal(boundedSourceTimeout(-1, 4_000), 10);
  assert.equal(boundedSourceTimeout(90_000, 4_000), 15_000);
});

const day = (date: string, pop: number): DailyForecast => ({
  date,
  temperatureMax: 27,
  temperatureMin: 19,
  precipitationProbability: pop,
  condition: "rain",
  sunrise: null,
  sunset: null,
  precipitationAmount: 2,
});

interface SpyOpts {
  /** "ok" → returns daily; "fail" → throws; "slow" → resolves daily after `delayMs`. */
  mode?: "ok" | "fail" | "slow";
  delayMs?: number;
  /** Mutated to count how many times this provider's normalized forecast read ran. */
  calls?: { n: number };
}

function spy(id: ProviderId, opts: SpyOpts = {}): WeatherProvider {
  const { mode = "ok", delayMs = 0, calls } = opts;
  return {
    id: id as WeatherProviderStatus["id"],
    name: id,
    read: async (): Promise<ProviderSnapshot> => {
      if (calls) calls.n += 1;
      if (mode === "fail") throw new Error("upstream down");
      if (mode === "slow") await new Promise((r) => setTimeout(r, delayMs));
      return {
        id: id as WeatherProviderStatus["id"],
        status: {
          id: id as WeatherProviderStatus["id"],
          name: id,
          availability: "ok",
          message: "",
          missingEnvVars: [],
          lastUpdated: "2026-06-19T12:00:00+09:00",
          fromCache: false,
        },
        current: {
          time: "2026-06-19T12:00:00+09:00",
          temperature: 27,
          apparentTemperature: null,
          humidity: null,
          windSpeed: null,
          windDirection: null,
          precipitation: null,
          cloudCover: null,
          condition: "rain",
        },
        hourly: [],
        daily: [day("2026-06-19", 40)],
      };
    },
  };
}

test("collectForecastSources: concurrent callers share ONE upstream cycle, not N", async () => {
  clearCache();
  const a = { n: 0 };
  const b = { n: 0 };
  const providers = [spy("open-meteo", { calls: a }), spy("weather-api", { calls: b })];

  const [r1, r2, r3] = await Promise.all([
    collectForecastSources(providers),
    collectForecastSources(providers),
    collectForecastSources(providers),
  ]);

  // Three concurrent /api/sky requests → exactly one fetch per provider.
  assert.equal(a.n, 1, "open-meteo fetched once for the whole burst");
  assert.equal(b.n, 1, "weather-api fetched once for the whole burst");
  // All callers get the same returned-only result.
  assert.deepEqual(r1.map((s) => s.source).sort(), ["open-meteo", "weather-api"]);
  assert.deepEqual(r2, r1);
  assert.deepEqual(r3, r1);
});

test("collectForecastSources: second call within TTL is a cache hit (no re-fetch)", async () => {
  clearCache();
  const a = { n: 0 };
  const providers = [spy("open-meteo", { calls: a })];

  await collectForecastSources(providers);
  await collectForecastSources(providers);

  assert.equal(a.n, 1, "TTL cache serves the second call without a new upstream fetch");
});

test("collectForecastSources: cache identity includes the forecast location", async () => {
  clearCache();
  const calls = { n: 0 };
  const providerList = [spy("open-meteo", { calls })];
  const seoul = createKoreanLocation({ name: "서울", latitude: 37.5665, longitude: 126.978 });
  const busan = createKoreanLocation({ name: "부산", latitude: 35.1796, longitude: 129.0756 });

  await collectForecastSources(providerList, { location: seoul });
  await collectForecastSources(providerList, { location: busan });
  await collectForecastSources(providerList, { location: seoul });

  assert.equal(calls.n, 2);
});

test("collectForecastSources: a failing source is DROPPED, others still returned", async () => {
  clearCache();
  const providers = [
    spy("open-meteo"),
    spy("weather-api", { mode: "fail" }),
    spy("kma"),
  ];
  const out = await collectForecastSources(providers);
  // The failing source is simply absent — never imputed, never a 0-amount placeholder.
  assert.deepEqual(out.map((s) => s.source).sort(), ["kma", "open-meteo"]);
});

test("collectForecastSources: a slow source past the per-source timeout is dropped", async () => {
  clearCache();
  const providers = [
    spy("open-meteo"),
    spy("weather-api", { mode: "slow", delayMs: 200 }),
  ];
  const out = await collectForecastSources(providers, { timeoutMs: 20 });
  assert.deepEqual(
    out.map((s) => s.source),
    ["open-meteo"],
    "the slow provider can't stall the cycle and is dropped",
  );
});

test("collectForecastSources: all sources down → [] (route then falls back to single-source)", async () => {
  clearCache();
  const providers = [spy("open-meteo", { mode: "fail" }), spy("kma", { mode: "fail" })];
  const out = await collectForecastSources(providers);
  assert.deepEqual(out, []);
});
