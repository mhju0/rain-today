import assert from "node:assert/strict";
import test from "node:test";
import { clearCache } from "../cache.ts";
import type { CurrentWeather, DailyForecast, HourlyForecast, ProviderSnapshot } from "../types.ts";
import { createWeatherProvider } from "./read.ts";
import { readAvailableProviderDaily } from "./read.ts";

const current: CurrentWeather = {
  time: "2026-07-14T00:00:00.000Z",
  temperature: 25,
  apparentTemperature: 26,
  humidity: 60,
  windSpeed: 3,
  windDirection: 180,
  precipitation: 0,
  cloudCover: 20,
  condition: "clear",
};

const hourly: HourlyForecast[] = [
  { time: "2026-07-14T01:00:00.000Z", temperature: 24, precipitationProbability: 0, windSpeed: 2, humidity: 65, condition: "clear" },
];

const daily: DailyForecast[] = [
  { date: "2026-07-14", temperatureMax: 30, temperatureMin: 22, precipitationProbability: 10, condition: "clear", sunrise: null, sunset: null },
];

const messages = {
  ok: "ok",
  stale: "stale",
  needsConfig: "config",
  error: "error",
};

test("createWeatherProvider reads one cached generation with coherent data and status", async () => {
  clearCache();
  let calls = 0;
  const provider = createWeatherProvider({
    id: "open-meteo",
    name: "Open-Meteo",
    messages,
    missingConfiguration: () => [],
    ttlMs: 60_000,
    load: async () => {
      calls += 1;
      return { current, hourly, daily };
    },
  });

  const first = await provider.read();
  const second = await provider.read();

  assert.equal(calls, 1);
  assert.equal(first.status.lastUpdated, first.current?.time);
  assert.equal(first.status.fromCache, false);
  assert.equal(first.status.stale, false);
  assert.equal(second.status.lastUpdated, second.current?.time);
  assert.equal(second.status.fromCache, true);
  assert.equal(second.status.stale, false);
  assert.deepEqual(second.daily, daily);
});

test("createWeatherProvider keeps generation markers coherent across every view in one read", async () => {
  clearCache();
  let calls = 0;
  const provider = createWeatherProvider({
    id: "open-meteo",
    name: "Open-Meteo",
    messages,
    missingConfiguration: () => [],
    ttlMs: 0,
    load: async () => {
      calls += 1;
      const date = `2026-07-${13 + calls}`;
      const time = `${date}T0${calls}:00:00.000Z`;
      return {
        current: { ...current, time, temperature: calls },
        hourly: [{ ...hourly[0], time, temperature: calls }],
        daily: [{ ...daily[0], date, temperatureMax: calls }],
      };
    },
  });

  const snapshot = await provider.read();

  assert.equal(snapshot.status.lastUpdated, "2026-07-14T01:00:00.000Z");
  assert.equal(snapshot.current?.time, "2026-07-14T01:00:00.000Z");
  assert.equal(snapshot.current?.temperature, 1);
  assert.equal(snapshot.hourly[0]?.time, "2026-07-14T01:00:00.000Z");
  assert.equal(snapshot.hourly[0]?.temperature, 1);
  assert.equal(snapshot.daily[0]?.date, "2026-07-14");
  assert.equal(snapshot.daily[0]?.temperatureMax, 1);
  assert.equal(calls, 1);
});

test("createWeatherProvider keeps stale fallback status and weather from the same cached generation", async () => {
  clearCache();
  let calls = 0;
  const provider = createWeatherProvider({
    id: "open-meteo",
    name: "Open-Meteo",
    messages,
    missingConfiguration: () => [],
    ttlMs: 0,
    load: async () => {
      calls += 1;
      if (calls === 2) throw new Error("upstream unavailable");
      return { current, hourly, daily };
    },
  });

  await provider.read();
  const snapshot = await provider.read();

  assert.equal(calls, 2);
  assert.equal(snapshot.status.availability, "ok");
  assert.equal(snapshot.status.message, "stale");
  assert.equal(snapshot.status.lastUpdated, snapshot.current?.time);
  assert.equal(snapshot.status.fromCache, true);
  assert.equal(snapshot.status.stale, true);
  assert.deepEqual(snapshot.daily, daily);
});

test("createWeatherProvider returns needs-config without loading weather", async () => {
  clearCache();
  let calls = 0;
  const provider = createWeatherProvider({
    id: "weather-api",
    name: "WeatherAPI",
    messages,
    missingConfiguration: () => ["WEATHERAPI_KEY"],
    ttlMs: 60_000,
    load: async () => {
      calls += 1;
      return { current, hourly, daily };
    },
  });

  const snapshot = await provider.read();

  assert.equal(calls, 0);
  assert.deepEqual(snapshot, {
    id: "weather-api",
    status: {
      id: "weather-api",
      name: "WeatherAPI",
      availability: "needs-config",
      message: "config",
      missingEnvVars: ["WEATHERAPI_KEY"],
      lastUpdated: null,
      fromCache: false,
    },
    current: null,
    hourly: [],
    daily: [],
  });
});

test("createWeatherProvider isolates a loader failure as an empty error snapshot", async () => {
  clearCache();
  const provider = createWeatherProvider({
    id: "pirate-weather",
    name: "Pirate Weather",
    messages,
    missingConfiguration: () => [],
    ttlMs: 60_000,
    load: async () => Promise.reject(new Error("upstream unavailable")),
  });

  const snapshot = await provider.read();

  assert.deepEqual(snapshot, {
    id: "pirate-weather",
    status: {
      id: "pirate-weather",
      name: "Pirate Weather",
      availability: "error",
      message: "error",
      missingEnvVars: [],
      lastUpdated: null,
      fromCache: false,
    },
    current: null,
    hourly: [],
    daily: [],
  });
});

test("createWeatherProvider exposes only a sanitized provider-specific failure message", async () => {
  clearCache();
  const provider = createWeatherProvider({
    id: "kma",
    name: "KMA",
    messages,
    missingConfiguration: () => [],
    ttlMs: 60_000,
    load: async () => Promise.reject(new Error("serviceKey=SECRET")),
    failureMessage: () => "authorization failed",
  });

  const snapshot = await provider.read();

  assert.equal(snapshot.status.message, "authorization failed");
  assert.ok(!JSON.stringify(snapshot).includes("SECRET"));
});

test("createWeatherProvider falls back to the generic error when failure classification throws", async () => {
  clearCache();
  const provider = createWeatherProvider({
    id: "kma",
    name: "KMA",
    messages,
    missingConfiguration: () => [],
    ttlMs: 60_000,
    load: async () => Promise.reject(new Error("serviceKey=SECRET")),
    failureMessage: () => {
      throw new Error("classifier failed");
    },
  });

  const snapshot = await provider.read();

  assert.deepEqual(snapshot, {
    id: "kma",
    status: {
      id: "kma",
      name: "KMA",
      availability: "error",
      message: "error",
      missingEnvVars: [],
      lastUpdated: null,
      fromCache: false,
    },
    current: null,
    hourly: [],
    daily: [],
  });
});

test("createWeatherProvider preserves distinct adapter and status display names", async () => {
  clearCache();
  const provider = createWeatherProvider({
    id: "kma",
    name: "기상청 (KMA)",
    statusName: "기상청 단기예보 (KMA)",
    messages,
    missingConfiguration: () => ["KMA_SHORT_TERM_API_KEY"],
    ttlMs: 60_000,
    load: async () => ({ current, hourly, daily }),
  });

  const snapshot = await provider.read();

  assert.equal(provider.name, "기상청 (KMA)");
  assert.equal(snapshot.status.name, "기상청 단기예보 (KMA)");
});

test("readAvailableProviderDaily projects one atomic provider read", async () => {
  const snapshot: ProviderSnapshot = {
    id: "kma",
    status: {
      id: "kma",
      name: "KMA",
      availability: "ok",
      message: "ok",
      missingEnvVars: [],
      lastUpdated: current.time,
      fromCache: false,
    },
    current,
    hourly,
    daily,
  };
  let calls = 0;

  const result = await readAvailableProviderDaily({
    id: "kma",
    name: "KMA",
    read: async () => {
      calls += 1;
      return snapshot;
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(result, { source: "kma", daily });
});
