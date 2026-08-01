import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { WeatherProvider } from "../providers/base.ts";
import { providers } from "../providers/registry.ts";
import type { ProviderSnapshot, WeatherProviderStatus } from "../types.ts";
import { collectForecasts } from "./forecastLog.ts";

const originalProviders = [...providers];

function provider(
  id: WeatherProviderStatus["id"],
  snapshot: Omit<ProviderSnapshot, "id">,
  calls: { n: number },
): WeatherProvider {
  return {
    id,
    name: id,
    async read() {
      calls.n += 1;
      return { id, ...snapshot };
    },
  };
}

afterEach(() => {
  providers.splice(0, providers.length, ...originalProviders);
});

test("collectForecasts reads each provider once and records its target-date forecast", async () => {
  const firstCalls = { n: 0 };
  const secondCalls = { n: 0 };
  const status = (id: WeatherProviderStatus["id"]): WeatherProviderStatus => ({
    id,
    name: id,
    availability: "ok",
    message: "ok",
    missingEnvVars: [],
    lastUpdated: "2026-06-19T12:00:00+09:00",
    fromCache: false,
  });
  const current = {
    time: "2026-06-19T12:00:00+09:00",
    temperature: 27,
    apparentTemperature: null,
    humidity: null,
    windSpeed: null,
    windDirection: null,
    precipitation: null,
    cloudCover: null,
    condition: "rain" as const,
  };
  const daily = [{
    date: "2026-06-20",
    temperatureMax: 28,
    temperatureMin: 20,
    precipitationProbability: 60,
    precipitationAmount: 4,
    condition: "rain" as const,
    sunrise: null,
    sunset: null,
  }];

  providers.splice(
    0,
    providers.length,
    provider("open-meteo", { status: status("open-meteo"), current, hourly: [], daily }, firstCalls),
    provider("kma", { status: status("kma"), current, hourly: [], daily }, secondCalls),
  );

  const records = await collectForecasts("2026-06-20", new Date("2026-06-19T03:00:00.000Z"));

  assert.equal(firstCalls.n, 1);
  assert.equal(secondCalls.n, 1);
  assert.deepEqual(records, [
    {
      date: "2026-06-20",
      source: "open-meteo",
      region: "seoul",
      pop: 60,
      predicted_mm: 4,
      loggedAt: "2026-06-19T03:00:00.000Z",
    },
    {
      date: "2026-06-20",
      source: "kma",
      region: "seoul",
      pop: 60,
      predicted_mm: 4,
      loggedAt: "2026-06-19T03:00:00.000Z",
    },
  ]);
});

test("collectForecasts omits unavailable and target-date-missing providers", async () => {
  const unavailableCalls = { n: 0 };
  const missingDateCalls = { n: 0 };
  const empty = { current: null, hourly: [], daily: [] };

  providers.splice(
    0,
    providers.length,
    provider("weather-api", {
      status: {
        id: "weather-api",
        name: "WeatherAPI",
        availability: "needs-config",
        message: "not configured",
        missingEnvVars: ["WEATHERAPI_KEY"],
        lastUpdated: null,
        fromCache: false,
      },
      ...empty,
    }, unavailableCalls),
    provider("kma", {
      status: {
        id: "kma",
        name: "KMA",
        availability: "ok",
        message: "ok",
        missingEnvVars: [],
        lastUpdated: null,
        fromCache: false,
      },
      ...empty,
    }, missingDateCalls),
  );

  assert.deepEqual(await collectForecasts("2026-06-20"), []);
  assert.equal(unavailableCalls.n, 1);
  assert.equal(missingDateCalls.n, 1);
});
