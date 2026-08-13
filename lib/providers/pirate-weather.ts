import { readResponseBytes } from "../httpResponse.ts";
import { DEFAULT_FORECAST_LOCATION, type ForecastLocation } from "../location.ts";
import { CACHE_TTL_MS } from "../seoul.ts";
import type {
  CurrentWeather,
  DailyForecast,
  HourlyForecast,
  WeatherCondition,
} from "../types";
import { createWeatherProvider } from "./read.ts";

/**
 * Pirate Weather — Dark Sky-compatible API, requires a free API key.
 * https://pirateweather.net/en/latest/
 * Set PIRATE_WEATHER_API_KEY to activate; without it the provider reports
 * needs-config and the other sources carry on.
 *
 * units=si: temperature °C, wind m/s (converted to km/h), precip mm/hr,
 * visibility km, humidity/cloudCover on 0–1 (scaled to 0–100 here).
 * precipProbability is 0–1 in all blocks (scaled to 0–100 for our schema).
 */

const PIRATE_WEATHER_BASE = "https://api.pirateweather.net/forecast/";
const PIRATE_WEATHER_MAX_BYTES = 2 * 1024 * 1024;
const PIRATE_WEATHER_KEY = /^[A-Za-z0-9_-]{16,256}$/;

function apiKey(): string | null {
  const value = process.env.PIRATE_WEATHER_API_KEY?.trim();
  return value && PIRATE_WEATHER_KEY.test(value) ? value : null;
}

export function buildPirateWeatherUrl(
  key: string,
  location: ForecastLocation = DEFAULT_FORECAST_LOCATION,
): URL {
  if (!PIRATE_WEATHER_KEY.test(key)) throw new Error("Pirate Weather: invalid API key format");
  const url = new URL(PIRATE_WEATHER_BASE);
  url.pathname += `${encodeURIComponent(key)}/${location.latitude},${location.longitude}`;
  url.searchParams.set("units", "si");
  return url;
}

function conditionFromIcon(icon: string | undefined): WeatherCondition {
  if (!icon) return "unknown";
  if (icon === "clear-day" || icon === "clear-night") return "clear";
  if (icon === "partly-cloudy-day" || icon === "partly-cloudy-night") return "partly-cloudy";
  if (icon === "cloudy") return "cloudy";
  if (icon === "fog") return "fog";
  if (icon === "rain") return "rain";
  if (icon === "snow") return "snow";
  if (icon === "sleet") return "sleet";
  return "unknown";
}

const mps2kmh = (v: number | undefined): number | null =>
  v === undefined ? null : Math.round(v * 3.6 * 10) / 10;

/** Unix seconds → ISO 8601 KST (e.g. "2026-06-18T15:00:00+09:00"). */
function unixToKstIso(ts: number): string {
  const kstMs = ts * 1000 + 9 * 3600 * 1000;
  return new Date(kstMs).toISOString().replace("Z", "+09:00");
}

const seoulDateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function unixToSeoulDate(ts: number): string {
  return seoulDateFmt.format(new Date(ts * 1000));
}

interface PwDataPoint {
  time: number;
  temperature?: number;
  apparentTemperature?: number;
  humidity?: number;
  windSpeed?: number;
  windBearing?: number;
  windGust?: number;
  precipProbability?: number;
  precipIntensity?: number;
  cloudCover?: number;
  visibility?: number;
  icon?: string;
  temperatureHigh?: number;
  temperatureLow?: number;
  sunriseTime?: number;
  sunsetTime?: number;
}

interface PwResponse {
  currently: PwDataPoint;
  hourly: { data: PwDataPoint[] };
  daily: { data: PwDataPoint[] };
}

interface Snapshot {
  current: CurrentWeather;
  hourly: HourlyForecast[];
  daily: DailyForecast[];
}

async function fetchSnapshot(location: ForecastLocation): Promise<Snapshot> {
  const key = apiKey();
  if (!key) throw new Error("Pirate Weather: PIRATE_WEATHER_API_KEY not configured");
  const url = buildPirateWeatherUrl(key, location);
  const res = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 403) throw new Error("Pirate Weather 403 — invalid or expired API key");
  if (res.status === 429) throw new Error("Pirate Weather 429 — rate limited");
  if (!res.ok) throw new Error(`Pirate Weather HTTP ${res.status}`);
  const bytes = await readResponseBytes(res, {
    maxBytes: PIRATE_WEATHER_MAX_BYTES,
    contentType: "application/json",
  });
  const data = JSON.parse(new TextDecoder().decode(bytes)) as PwResponse;

  const c = data.currently;
  const current: CurrentWeather = {
    time: unixToKstIso(c.time),
    temperature: c.temperature ?? 0,
    apparentTemperature: c.apparentTemperature ?? null,
    humidity: c.humidity !== undefined ? Math.round(c.humidity * 100) : null,
    windSpeed: mps2kmh(c.windSpeed),
    windDirection: c.windBearing ?? null,
    precipitation: c.precipIntensity ?? null,
    cloudCover: c.cloudCover !== undefined ? Math.round(c.cloudCover * 100) : null,
    condition: conditionFromIcon(c.icon),
    windGusts: mps2kmh(c.windGust),
    precipitationProbability:
      c.precipProbability !== undefined ? Math.round(c.precipProbability * 100) : null,
    visibility: c.visibility ?? null,
  };

  const nowMs = Date.now();
  const hourly: HourlyForecast[] = (data.hourly?.data ?? [])
    .filter((h) => h.time * 1000 >= nowMs - 30 * 60 * 1000)
    .slice(0, 24)
    .map(
      (h): HourlyForecast => ({
        time: unixToKstIso(h.time),
        temperature: h.temperature ?? 0,
        precipitationProbability:
          h.precipProbability !== undefined ? Math.round(h.precipProbability * 100) : null,
        windSpeed: mps2kmh(h.windSpeed),
        humidity: h.humidity !== undefined ? Math.round(h.humidity * 100) : null,
        condition: conditionFromIcon(h.icon),
      }),
    );

  const daily: DailyForecast[] = (data.daily?.data ?? [])
    .slice(0, 7)
    .map(
      (d): DailyForecast => ({
        date: unixToSeoulDate(d.time),
        temperatureMax: d.temperatureHigh ?? d.temperature ?? 0,
        temperatureMin: d.temperatureLow ?? d.temperature ?? 0,
        precipitationProbability:
          d.precipProbability !== undefined ? Math.round(d.precipProbability * 100) : null,
        condition: conditionFromIcon(d.icon),
        sunrise: d.sunriseTime !== undefined ? unixToKstIso(d.sunriseTime) : null,
        sunset: d.sunsetTime !== undefined ? unixToKstIso(d.sunsetTime) : null,
      }),
    );

  return { current, hourly, daily };
}

export const pirateWeatherProvider = createWeatherProvider({
  id: "pirate-weather",
  name: "Pirate Weather",
  messages: {
    ok: "Pirate Weather API (Dark Sky 호환 글로벌 모델)",
    stale: "일시적 연결 오류 — 최근 캐시 데이터 표시 중",
    needsConfig: "PIRATE_WEATHER_API_KEY를 설정하면 비교 소스로 활성화됩니다",
    error: "Pirate Weather 연결 실패 (인증 오류 또는 네트워크 — 잠시 후 재시도)",
  },
  missingConfiguration: () => apiKey() ? [] : ["PIRATE_WEATHER_API_KEY"],
  ttlMs: CACHE_TTL_MS,
  load: fetchSnapshot,
  failureMessage: () => "Pirate Weather 연결 실패 (인증 오류 또는 네트워크 — 잠시 후 재시도)",
});
