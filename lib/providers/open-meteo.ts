import { conditionFromWmoCode } from "../conditions.ts";
import { CACHE_TTL_MS, SEOUL } from "../seoul.ts";
import type {
  CurrentWeather,
  DailyForecast,
  HourlyForecast,
} from "../types";
import { createWeatherProvider } from "./read.ts";

/**
 * Open-Meteo — the default provider. Free, no API key, no signup.
 * https://open-meteo.com/en/docs
 */

interface OpenMeteoResponse {
  current: {
    time: string;
    temperature_2m: number;
    relative_humidity_2m: number;
    apparent_temperature: number;
    precipitation: number;
    rain: number;
    snowfall: number;
    weather_code: number;
    cloud_cover: number;
    wind_speed_10m: number;
    wind_gusts_10m: number;
    wind_direction_10m: number;
    is_day: number;
    visibility: number;
  };
  hourly: {
    time: string[];
    temperature_2m: number[];
    precipitation_probability: (number | null)[];
    weather_code: number[];
    wind_speed_10m: number[];
    relative_humidity_2m: number[];
  };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: (number | null)[];
    precipitation_sum: (number | null)[];
    sunrise: string[];
    sunset: string[];
  };
}

interface Snapshot {
  current: CurrentWeather;
  hourly: HourlyForecast[];
  daily: DailyForecast[];
}

/** Open-Meteo returns naive local timestamps ("2026-06-12T23:45") — pin them to KST. */
function toKstIso(naive: string): string {
  return `${naive}:00+09:00`.replace(/:00:00\+/, ":00+");
}

async function fetchSnapshot(): Promise<Snapshot> {
  const params = new URLSearchParams({
    latitude: String(SEOUL.latitude),
    longitude: String(SEOUL.longitude),
    timezone: SEOUL.timezone,
    forecast_days: "7",
    current:
      "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m,wind_direction_10m,is_day,visibility",
    hourly:
      "temperature_2m,precipitation_probability,weather_code,wind_speed_10m,relative_humidity_2m",
    daily:
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset",
  });

  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const data = (await res.json()) as OpenMeteoResponse;

  // Index of the hour bucket covering "now" — also the start of the 24h slice.
  const nowMs = Date.parse(toKstIso(data.current.time));
  const startIdx = Math.max(
    data.hourly.time.findIndex((t) => Date.parse(toKstIso(t)) >= nowMs - 30 * 60 * 1000),
    0,
  );

  const current: CurrentWeather = {
    time: toKstIso(data.current.time),
    temperature: data.current.temperature_2m,
    apparentTemperature: data.current.apparent_temperature,
    humidity: data.current.relative_humidity_2m,
    windSpeed: data.current.wind_speed_10m,
    windDirection: data.current.wind_direction_10m,
    precipitation: data.current.precipitation,
    cloudCover: data.current.cloud_cover,
    condition: conditionFromWmoCode(data.current.weather_code),
    windGusts: data.current.wind_gusts_10m ?? null,
    rain: data.current.rain ?? null,
    snowfall: data.current.snowfall ?? null,
    precipitationProbability: data.hourly.precipitation_probability[startIdx] ?? null,
    visibility: data.current.visibility ?? null,
    isDay: typeof data.current.is_day === "number" ? data.current.is_day === 1 : null,
    weatherCode: data.current.weather_code ?? null,
  };
  const hourly: HourlyForecast[] = data.hourly.time
    .slice(startIdx, startIdx + 24)
    .map((t, i) => {
      const idx = startIdx + i;
      return {
        time: toKstIso(t),
        temperature: data.hourly.temperature_2m[idx],
        precipitationProbability: data.hourly.precipitation_probability[idx] ?? null,
        windSpeed: data.hourly.wind_speed_10m[idx],
        humidity: data.hourly.relative_humidity_2m[idx],
        condition: conditionFromWmoCode(data.hourly.weather_code[idx]),
      };
    });

  const daily: DailyForecast[] = data.daily.time.map((date, i) => ({
    date,
    temperatureMax: data.daily.temperature_2m_max[i],
    temperatureMin: data.daily.temperature_2m_min[i],
    precipitationProbability: data.daily.precipitation_probability_max[i] ?? null,
    condition: conditionFromWmoCode(data.daily.weather_code[i]),
    sunrise: toKstIso(data.daily.sunrise[i]),
    sunset: toKstIso(data.daily.sunset[i]),
    precipitationAmount: data.daily.precipitation_sum?.[i] ?? null,
  }));

  return { current, hourly, daily };
}

export const openMeteoProvider = createWeatherProvider({
  id: "open-meteo",
  name: "Open-Meteo",
  messages: {
    ok: "무료 글로벌 예보 모델 (API 키 불필요)",
    stale: "일시적 연결 오류 — 최근 캐시 데이터 표시 중",
    needsConfig: "",
    error: "Open-Meteo 서버에 연결할 수 없습니다",
  },
  missingConfiguration: () => [],
  ttlMs: CACHE_TTL_MS,
  load: fetchSnapshot,
  failureMessage: () => "Open-Meteo 서버에 연결할 수 없습니다",
});
