import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { clearCache } from "../cache.ts";
import { metNorwayProvider } from "./met-norway.ts";
import { openMeteoProvider } from "./open-meteo.ts";
import { weatherApiProvider } from "./weather-api.ts";

const realFetch = globalThis.fetch;
const nowSeconds = Math.floor(Date.now() / 1000);

const openMeteoBody = JSON.stringify({
  current: {
    time: "2026-08-14T12:00",
    temperature_2m: 27,
    relative_humidity_2m: 60,
    apparent_temperature: 28,
    precipitation: 0,
    rain: 0,
    snowfall: 0,
    weather_code: 0,
    cloud_cover: 10,
    wind_speed_10m: 4,
    wind_gusts_10m: 8,
    wind_direction_10m: 180,
    is_day: 1,
    visibility: 10_000,
  },
  hourly: {
    time: ["2026-08-14T12:00"],
    temperature_2m: [27],
    precipitation_probability: [10],
    weather_code: [0],
    wind_speed_10m: [4],
    relative_humidity_2m: [60],
  },
  daily: {
    time: [],
    weather_code: [],
    temperature_2m_max: [],
    temperature_2m_min: [],
    precipitation_probability_max: [],
    precipitation_sum: [],
    sunrise: [],
    sunset: [],
  },
});

const metNorwayBody = JSON.stringify({
  properties: {
    timeseries: [{
      time: new Date((nowSeconds + 3600) * 1000).toISOString(),
      data: {
        instant: { details: { air_temperature: 27 } },
        next_1_hours: { summary: { symbol_code: "clearsky_day" } },
      },
    }],
  },
});

const weatherApiBody = JSON.stringify({
  current: {
    last_updated_epoch: nowSeconds,
    temp_c: 27,
    humidity: 60,
    wind_kph: 4,
    condition: { code: 1000 },
  },
  forecast: { forecastday: [] },
});

beforeEach(() => {
  process.env.MET_NO_USER_AGENT = "SeoulSky test contact@example.com";
  process.env.WEATHERAPI_KEY = "MOCK-WEATHER-API-KEY";
  clearCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.MET_NO_USER_AGENT;
  delete process.env.WEATHERAPI_KEY;
  clearCache();
});

test("local forecast providers reject responses whose declared size exceeds the limit", async () => {
  for (const [provider, body] of [
    [openMeteoProvider, openMeteoBody],
    [metNorwayProvider, metNorwayBody],
    [weatherApiProvider, weatherApiBody],
  ] as const) {
    globalThis.fetch = (async () => new Response(body, {
      status: 200,
      headers: {
        "Content-Length": String(2 * 1024 * 1024 + 1),
        "Content-Type": "application/json",
      },
    })) as typeof fetch;

    const snapshot = await provider.read();
    assert.equal(snapshot.status.availability, "error", provider.id);
    clearCache();
  }
});
