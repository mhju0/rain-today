import { readResponseBytes } from "../httpResponse.ts";
import type { ForecastLocation } from "../location.ts";
import type {
  CurrentWeather,
  DailyForecast,
  HourlyForecast,
  WeatherCondition,
} from "../types";
import { createWeatherProvider } from "./read.ts";

/**
 * MET Norway (Norwegian Meteorological Institute) — free, no API key, but their
 * terms REQUIRE an identifying User-Agent with contact info. We treat it as
 * opt-in: set MET_NO_USER_AGENT (e.g. "SeoulSky/1.0 contact@example.com") to
 * activate it. Without it the provider reports needs-config and the app simply
 * continues on Open-Meteo — we never hit MET with a generic User-Agent.
 * https://api.met.no/weatherapi/locationforecast/2.0/documentation
 *
 * Always server-side (the contact UA must never reach the browser). Precipitation
 * *probability* is only published for the Nordics, so it is honestly null for
 * Seoul — amounts and everything else are global.
 */

/** Identifying User-Agent (with contact) from env, or null when unconfigured. */
function userAgent(): string | null {
  return process.env.MET_NO_USER_AGENT?.trim() || null;
}

/** MET asks clients to cache responses; honor that with a longer-than-default TTL. */
const MET_TTL_MS = 15 * 60 * 1000;
const MET_MAX_BYTES = 2 * 1024 * 1024;

/** symbol_code base (before _day/_night) → internal condition */
function conditionFromSymbol(symbolCode: string | undefined): WeatherCondition {
  if (!symbolCode) return "unknown";
  const base = symbolCode.split("_")[0];
  if (base.includes("thunder")) return "thunderstorm";
  if (base.startsWith("heavyrain")) return "heavy-rain";
  if (base.startsWith("lightrain")) return "drizzle";
  if (base.startsWith("rain")) return "rain";
  if (base.includes("sleet")) return "sleet";
  if (base.includes("snow")) return "snow";
  if (base === "fog") return "fog";
  if (base === "cloudy") return "overcast";
  if (base === "partlycloudy") return "cloudy";
  if (base === "fair") return "partly-cloudy";
  if (base.startsWith("clearsky")) return "clear";
  return "unknown";
}

interface MetTimeseries {
  time: string;
  data: {
    instant: {
      details: {
        air_temperature: number;
        relative_humidity?: number;
        wind_speed?: number;
        wind_from_direction?: number;
        cloud_area_fraction?: number;
      };
    };
    next_1_hours?: {
      summary?: { symbol_code?: string };
      details?: { precipitation_amount?: number };
    };
    next_6_hours?: {
      summary?: { symbol_code?: string };
      details?: { precipitation_amount?: number };
    };
  };
}

interface Snapshot {
  current: CurrentWeather;
  hourly: HourlyForecast[];
  daily: DailyForecast[];
}

const mps2kmh = (v: number | undefined): number | null =>
  v === undefined ? null : Math.round(v * 3.6 * 10) / 10;

function symbolOf(ts: MetTimeseries): string | undefined {
  return ts.data.next_1_hours?.summary?.symbol_code ?? ts.data.next_6_hours?.summary?.symbol_code;
}

async function fetchSnapshot(location: ForecastLocation): Promise<Snapshot> {
  const ua = userAgent();
  if (!ua) throw new Error("MET Norway: MET_NO_USER_AGENT not configured");
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${location.latitude}&lon=${location.longitude}`;
  const res = await fetch(url, {
    headers: { "User-Agent": ua },
    signal: AbortSignal.timeout(10_000),
  });
  // MET blocks generic/abusive clients (403) and rate-limits (429); surface both.
  if (res.status === 403) throw new Error("MET Norway 403 — User-Agent rejected");
  if (res.status === 429) throw new Error("MET Norway 429 — rate limited");
  if (!res.ok) throw new Error(`MET Norway HTTP ${res.status}`);
  const bytes = await readResponseBytes(res, {
    maxBytes: MET_MAX_BYTES,
    contentType: "application/json",
  });
  const data = JSON.parse(new TextDecoder().decode(bytes)) as {
    properties: { timeseries: MetTimeseries[] };
  };
  const series = data.properties.timeseries;
  if (series.length === 0) throw new Error("MET Norway: empty timeseries");
  const localDateFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone: location.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const localHourFormat = new Intl.DateTimeFormat("en-GB", {
    timeZone: location.timezone,
    hour: "2-digit",
    hour12: false,
  });

  const toEntry = (ts: MetTimeseries): HourlyForecast => {
    const d = ts.data.instant.details;
    return {
      time: ts.time,
      temperature: d.air_temperature,
      precipitationProbability: null, // not published outside the Nordics
      windSpeed: mps2kmh(d.wind_speed),
      humidity: d.relative_humidity ?? null,
      condition: conditionFromSymbol(symbolOf(ts)),
    };
  };

  const nowMs = Date.now();
  const upcoming = series.filter((ts) => Date.parse(ts.time) >= nowMs - 30 * 60 * 1000);
  const hourly = upcoming.slice(0, 24).map(toEntry);

  const first = upcoming[0] ?? series[0];
  const fd = first.data.instant.details;
  const current: CurrentWeather = {
    time: first.time,
    temperature: fd.air_temperature,
    apparentTemperature: null,
    humidity: fd.relative_humidity ?? null,
    windSpeed: mps2kmh(fd.wind_speed),
    windDirection: fd.wind_from_direction ?? null,
    precipitation: first.data.next_1_hours?.details?.precipitation_amount ?? null,
    cloudCover: fd.cloud_area_fraction !== undefined ? Math.round(fd.cloud_area_fraction) : null,
    condition: conditionFromSymbol(symbolOf(first)),
  };

  // Daily: aggregate instant temps per Seoul-local date. Today's min/max only
  // cover the remaining hours — an acceptable approximation for a side source.
  const byDate = new Map<string, MetTimeseries[]>();
  for (const ts of upcoming) {
    const date = localDateFormat.format(new Date(ts.time));
    byDate.set(date, [...(byDate.get(date) ?? []), ts]);
  }
  const daily: DailyForecast[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([, list]) => list.length >= 4)
    .slice(0, 7)
    .map(([date, list]) => {
      const temps = list.map((ts) => ts.data.instant.details.air_temperature);
      const midday =
        list.find((ts) => Number(localHourFormat.format(new Date(ts.time))) >= 12) ??
        list[Math.floor(list.length / 2)];
      return {
        date,
        temperatureMax: Math.max(...temps),
        temperatureMin: Math.min(...temps),
        precipitationProbability: null,
        condition: conditionFromSymbol(symbolOf(midday)),
        sunrise: null,
        sunset: null,
      };
    });

  return { current, hourly, daily };
}

export const metNorwayProvider = createWeatherProvider({
  id: "met-norway",
  name: "MET Norway",
  messages: {
    ok: "노르웨이 기상청 글로벌 모델 (식별 User-Agent 필요)",
    stale: "일시적 연결 오류 — 최근 캐시 데이터 표시 중",
    needsConfig: "MET_NO_USER_AGENT(연락처 포함)를 설정하면 비교 소스로 활성화됩니다",
    error: "MET Norway 연결 실패 (403/429 또는 네트워크 — 잠시 후 재시도)",
  },
  missingConfiguration: () => userAgent() ? [] : ["MET_NO_USER_AGENT"],
  ttlMs: MET_TTL_MS,
  load: fetchSnapshot,
  failureMessage: () => "MET Norway 연결 실패 (403/429 또는 네트워크 — 잠시 후 재시도)",
});
