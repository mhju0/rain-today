import type { ForecastLocation } from "../location.ts";
import { CACHE_TTL_MS } from "../seoul.ts";
import type {
  CurrentWeather,
  DailyForecast,
  HourlyForecast,
  WeatherCondition,
} from "../types";
import { createWeatherProvider } from "./read.ts";

/**
 * WeatherAPI.com — requires a free API key from weatherapi.com.
 * Set WEATHERAPI_KEY to activate; without it the provider reports needs-config.
 * https://www.weatherapi.com/docs/
 *
 * Units: temp_c (°C), wind_kph (km/h — no conversion needed),
 * humidity (0–100), cloud (0–100), chance_of_rain (0–100 integer — already %).
 * DO NOT divide chance_of_rain; it is not a 0–1 fraction.
 */

function apiKey(): string | null {
  return process.env.WEATHERAPI_KEY?.trim() || null;
}

/** WeatherAPI condition code → internal WeatherCondition. */
function conditionFromCode(code: number): WeatherCondition {
  switch (code) {
    case 1000:
      return "clear";
    case 1003:
      return "partly-cloudy";
    case 1006:
      return "cloudy";
    case 1009:
      return "overcast";
    case 1030:
    case 1135:
    case 1147:
      return "fog";
    // Thunderstorm
    case 1087:
    case 1273:
    case 1276:
    case 1279:
    case 1282:
      return "thunderstorm";
    // Heavy rain / torrential showers
    case 1192:
    case 1195:
    case 1243:
    case 1246:
      return "heavy-rain";
    // Rain (patchy, light, moderate, showers)
    case 1063:
    case 1180:
    case 1183:
    case 1186:
    case 1189:
    case 1240:
      return "rain";
    // Drizzle (inc. freezing drizzle)
    case 1072:
    case 1150:
    case 1153:
    case 1168:
    case 1171:
      return "drizzle";
    // Sleet / freezing rain / ice pellets
    case 1069:
    case 1198:
    case 1201:
    case 1204:
    case 1207:
    case 1237:
    case 1249:
    case 1252:
    case 1261:
    case 1264:
      return "sleet";
    // Snow
    case 1066:
    case 1114:
    case 1117:
    case 1210:
    case 1213:
    case 1216:
    case 1219:
    case 1222:
    case 1225:
    case 1255:
    case 1258:
      return "snow";
    default:
      return "unknown";
  }
}

/** Unix seconds → ISO 8601 KST (e.g. "2026-06-18T15:00:00.000+09:00"). */
function unixToKstIso(ts: number): string {
  const kstMs = ts * 1000 + 9 * 3600 * 1000;
  return new Date(kstMs).toISOString().replace("Z", "+09:00");
}

/** "05:11 AM" + "2026-06-18" → "2026-06-18T05:11:00+09:00", or null on parse failure. */
function astroToKstIso(date: string, timeStr: string): string | null {
  const m = /^(\d{1,2}):(\d{2})\s+(AM|PM)$/i.exec(timeStr.trim());
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const min = m[2];
  if (m[3].toUpperCase() === "PM" && hour !== 12) hour += 12;
  if (m[3].toUpperCase() === "AM" && hour === 12) hour = 0;
  return `${date}T${String(hour).padStart(2, "0")}:${min}:00+09:00`;
}

interface WaCondition {
  code: number;
}

interface WaCurrent {
  last_updated_epoch: number;
  temp_c: number;
  feelslike_c?: number;
  humidity: number;
  wind_kph: number;
  wind_degree?: number;
  gust_kph?: number;
  precip_mm?: number;
  cloud?: number;
  vis_km?: number;
  condition: WaCondition;
}

interface WaHour {
  time_epoch: number;
  temp_c: number;
  humidity: number;
  wind_kph: number;
  chance_of_rain: number;
  condition: WaCondition;
}

interface WaDay {
  maxtemp_c: number;
  mintemp_c: number;
  daily_chance_of_rain: number;
  /** Daily precipitation total (mm) — returned by default in the day object. */
  totalprecip_mm?: number;
  condition: WaCondition;
}

interface WaForecastDay {
  date: string;
  day: WaDay;
  astro: { sunrise: string; sunset: string };
  hour: WaHour[];
}

interface WaResponse {
  current: WaCurrent;
  forecast: { forecastday: WaForecastDay[] };
}

interface Snapshot {
  current: CurrentWeather;
  hourly: HourlyForecast[];
  daily: DailyForecast[];
}

async function fetchSnapshot(location: ForecastLocation): Promise<Snapshot> {
  const key = apiKey();
  if (!key) throw new Error("WeatherAPI: WEATHERAPI_KEY not configured");
  const url =
    `https://api.weatherapi.com/v1/forecast.json` +
    `?key=${key}&q=${location.latitude},${location.longitude}&days=2&aqi=no&alerts=no`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (res.status === 401 || res.status === 403)
    throw new Error(`WeatherAPI ${res.status} — invalid or expired API key`);
  if (res.status === 429) throw new Error("WeatherAPI 429 — rate limited");
  if (!res.ok) throw new Error(`WeatherAPI HTTP ${res.status}`);
  const data = (await res.json()) as WaResponse;

  const c = data.current;
  const current: CurrentWeather = {
    time: unixToKstIso(c.last_updated_epoch),
    temperature: c.temp_c,
    apparentTemperature: c.feelslike_c ?? null,
    humidity: c.humidity,
    windSpeed: c.wind_kph,
    windDirection: c.wind_degree ?? null,
    precipitation: c.precip_mm ?? null,
    cloudCover: c.cloud ?? null,
    condition: conditionFromCode(c.condition.code),
    windGusts: c.gust_kph ?? null,
    visibility: c.vis_km ?? null,
  };

  // Flatten all hours from the two forecast days, filter to ≥(now − 30 min).
  const nowMs = Date.now();
  const allHours = (data.forecast?.forecastday ?? []).flatMap((d) => d.hour);
  const hourly: HourlyForecast[] = allHours
    .filter((h) => h.time_epoch * 1000 >= nowMs - 30 * 60 * 1000)
    .slice(0, 24)
    .map(
      (h): HourlyForecast => ({
        time: unixToKstIso(h.time_epoch),
        temperature: h.temp_c,
        // chance_of_rain is already 0–100 — do not divide.
        precipitationProbability: h.chance_of_rain,
        windSpeed: h.wind_kph,
        humidity: h.humidity,
        condition: conditionFromCode(h.condition.code),
      }),
    );

  const daily: DailyForecast[] = (data.forecast?.forecastday ?? []).map(
    (d): DailyForecast => ({
      date: d.date,
      temperatureMax: d.day.maxtemp_c,
      temperatureMin: d.day.mintemp_c,
      // daily_chance_of_rain is already 0–100 — do not divide.
      precipitationProbability: d.day.daily_chance_of_rain,
      condition: conditionFromCode(d.day.condition.code),
      sunrise: astroToKstIso(d.date, d.astro.sunrise),
      sunset: astroToKstIso(d.date, d.astro.sunset),
      precipitationAmount: d.day.totalprecip_mm ?? null,
    }),
  );

  return { current, hourly, daily };
}

export const weatherApiProvider = createWeatherProvider({
  id: "weather-api",
  name: "WeatherAPI",
  messages: {
    ok: "WeatherAPI.com 글로벌 예보 모델",
    stale: "일시적 연결 오류 — 최근 캐시 데이터 표시 중",
    needsConfig: "WEATHERAPI_KEY를 설정하면 비교 소스로 활성화됩니다",
    error: "WeatherAPI 연결 실패 (인증 오류 또는 네트워크 — 잠시 후 재시도)",
  },
  missingConfiguration: () => apiKey() ? [] : ["WEATHERAPI_KEY"],
  ttlMs: CACHE_TTL_MS,
  load: fetchSnapshot,
  failureMessage: () => "WeatherAPI 연결 실패 (인증 오류 또는 네트워크 — 잠시 후 재시도)",
});
