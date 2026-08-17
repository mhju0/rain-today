import type { ForecastLocation } from "./location.ts";
import { blendPrecipitation } from "./performance/influence.ts";
import {
  buildRecentPerformanceProfile,
  DEFAULT_PERFORMANCE_POLICY,
} from "./performance/performance.ts";
import { PostgresPerformanceStore } from "./performance/postgres.ts";
import { findStationMatch } from "./performance/stations.ts";
import type { PerformanceStore } from "./performance/store.ts";
import type {
  CaptureCohort,
  CapturedProviderForecast,
  RecentPerformanceProfile,
  PrecipProviderId,
} from "./performance/types.ts";
import { providers as weatherProviders } from "./providers/registry.ts";
import type { ProviderSnapshot, WeatherCondition } from "./types.ts";

const PRECIP_PROVIDERS = new Set<PrecipProviderId>([
  "open-meteo",
  "met-norway",
  "kma",
  "pirate-weather",
  "weather-api",
]);
const STATION_POLICY = { maxDistanceKm: 100, maxElevationDifferenceM: 400 };
let runtimePerformanceStore: PostgresPerformanceStore | null = null;

export interface LocalForecastEvidence {
  status: "active" | "collecting" | "unavailable";
  reason:
    | "eligible-station"
    | "insufficient-evidence"
    | "benchmark-insufficient"
    | "benchmark-regression"
    | "no-eligible-station"
    | "database-not-configured"
    | "database-unavailable";
  station: { id: string; name: string; distanceKm: number } | null;
  profile: RecentPerformanceProfile | null;
}

export interface LocalForecastDay {
  date: string;
  precipitationProbability: number | null;
  precipitationAmountMm: number | null;
  temperatureMax: number | null;
  temperatureMin: number | null;
  condition: WeatherCondition;
}

export interface LocalForecastResponse {
  generatedAt: string;
  location: ForecastLocation;
  targetDate: string | null;
  captureCohort: CaptureCohort;
  /**
   * Observed conditions now, taken from the first provider in registry order
   * that is serving any. Availability is not gated on here: a stale last-good
   * snapshot still carries real observed weather, and dropping it would leave
   * the page emptier than the data warrants. Null when nobody has current
   * weather — the page shows an honest gap rather than reusing the target-date
   * blend, which describes tomorrow and not now.
   */
  current: {
    temperature: number;
    apparentTemperature: number | null;
    condition: WeatherCondition;
    observedAt: string;
    sourceName: string;
  } | null;
  recommendation: {
    precipitationProbability: number | null;
    precipitationAmountMm: number | null;
    temperatureMax: number | null;
    temperatureMin: number | null;
    condition: WeatherCondition;
  };
  /**
   * Today, always on equal weighting. The Recent Performance Profile scores
   * next-day forecasts only, so carrying it onto today's number would be an
   * accuracy claim nothing has verified. Null when no provider still publishes
   * a daily entry for today.
   */
  today: LocalForecastDay | null;
  outlook: LocalForecastDay[];
  providers: Array<{
    id: PrecipProviderId;
    name: string;
    probability: number | null;
    amountMm: number | null;
    available: boolean;
  }>;
  effectiveInfluence: Record<string, number>;
  performance: LocalForecastEvidence;
}

interface LocalForecastDependencies {
  now?: Date;
  readForecasts?: (location: ForecastLocation) => Promise<ProviderSnapshot[]>;
  readEvidence?: (
    location: ForecastLocation,
    elevationM: number | null,
    cohort: CaptureCohort,
    now: Date,
  ) => Promise<LocalForecastEvidence>;
}

function koreanHour(date: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(date),
  );
}

function koreanDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function nextCalendarDate(date: Date): string {
  return new Date(Date.parse(`${koreanDate(date)}T00:00:00.000Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function captureCohortAt(date: Date): CaptureCohort {
  const hour = koreanHour(date);
  return hour >= 6 && hour < 18 ? "06" : "18";
}

function validProbability(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 100;
}

function validAmount(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function buildForecastDay(
  date: string,
  snapshots: readonly ProviderSnapshot[],
  profile: RecentPerformanceProfile | null,
): LocalForecastDay | null {
  const rows = snapshots.flatMap((snapshot) => {
    if (!PRECIP_PROVIDERS.has(snapshot.id as PrecipProviderId)) return [];
    const daily = snapshot.daily.find((day) => day.date === date);
    if (!daily || !validProbability(daily.precipitationProbability)) return [];
    return [{
      provider: snapshot.id as PrecipProviderId,
      probability: daily.precipitationProbability,
      amountMm: validAmount(daily.precipitationAmount),
      temperatureMax: daily.temperatureMax,
      temperatureMin: daily.temperatureMin,
      condition: daily.condition,
    }];
  });
  if (rows.length === 0) return null;
  const forecasts: CapturedProviderForecast[] = rows.map((row) => ({
    provider: row.provider,
    probability: row.probability,
    amountMm: row.amountMm,
  }));
  const blend = blendPrecipitation(forecasts, profile);
  return {
    date,
    precipitationProbability: blend.probability,
    precipitationAmountMm: blend.amountMm,
    temperatureMax: rows[0].temperatureMax,
    temperatureMin: rows[0].temperatureMin,
    condition: rows[0].condition,
  };
}

async function readAllForecasts(location: ForecastLocation): Promise<ProviderSnapshot[]> {
  return Promise.all(weatherProviders.map((provider) => provider.read(location)));
}

export async function readDatabaseEvidence(
  location: ForecastLocation,
  elevationM: number | null,
  cohort: CaptureCohort,
  now: Date,
): Promise<LocalForecastEvidence> {
  const connectionUrl = process.env.PERFORMANCE_DATABASE_URL?.trim();
  if (!connectionUrl) {
    return { status: "unavailable", reason: "database-not-configured", station: null, profile: null };
  }
  runtimePerformanceStore ??= new PostgresPerformanceStore(connectionUrl);
  const store = runtimePerformanceStore;
  return readPerformanceEvidenceFromStore(store, location, elevationM, cohort, now);
}

export async function readPerformanceEvidenceFromStore(
  store: PerformanceStore,
  location: ForecastLocation,
  elevationM: number | null,
  cohort: CaptureCohort,
  now: Date,
): Promise<LocalForecastEvidence> {
  try {
    const stationMatch = findStationMatch({
      location: { ...location, elevationM },
      stations: await store.listStations(),
      at: now,
      policy: STATION_POLICY,
    });
    if (!stationMatch.station || stationMatch.distanceKm === null) {
      return { status: "unavailable", reason: "no-eligible-station", station: null, profile: null };
    }
    const comparisons = await store.loadCompletedComparisons(
      stationMatch.station.id,
      cohort,
      DEFAULT_PERFORMANCE_POLICY.fullInfluenceSamples,
    );
    const profile = buildRecentPerformanceProfile({
      stationId: stationMatch.station.id,
      cohort,
      captures: comparisons.map((comparison) => comparison.capture),
      observations: comparisons.map((comparison) => comparison.observation),
      asOf: now,
    });
    const active = profile.mode === "learned" || profile.mode === "ramping";
    const inactiveReason =
      profile.reason === "benchmark-insufficient" || profile.reason === "benchmark-regression"
        ? profile.reason
        : "insufficient-evidence";
    return {
      status: active ? "active" : "collecting",
      reason: active ? "eligible-station" : inactiveReason,
      station: {
        id: stationMatch.station.id,
        name: stationMatch.station.name,
        distanceKm: Math.round(stationMatch.distanceKm * 10) / 10,
      },
      profile,
    };
  } catch {
    return { status: "unavailable", reason: "database-unavailable", station: null, profile: null };
  }
}

/** Build the user-facing exact-location forecast with nearby-station evidence. */
export async function readLocalForecast(
  input: { location: ForecastLocation; elevationM: number | null },
  dependencies: LocalForecastDependencies = {},
): Promise<LocalForecastResponse> {
  const now = dependencies.now ?? new Date();
  const cohort = captureCohortAt(now);
  const snapshotsPromise = (dependencies.readForecasts ?? readAllForecasts)(input.location);
  const performancePromise = (dependencies.readEvidence ?? readDatabaseEvidence)(
    input.location,
    input.elevationM,
    cohort,
    now,
  );
  const snapshots = await snapshotsPromise;
  const targetDate = nextCalendarDate(now);
  const providerRows = snapshots.flatMap((snapshot) => {
    if (!PRECIP_PROVIDERS.has(snapshot.id as PrecipProviderId)) return [];
    const daily = targetDate ? snapshot.daily.find((day) => day.date === targetDate) : undefined;
    return [{
      id: snapshot.id as PrecipProviderId,
      name: snapshot.status.name,
      probability: daily?.precipitationProbability ?? null,
      amountMm: validAmount(daily?.precipitationAmount),
      temperatureMax: daily?.temperatureMax ?? null,
      temperatureMin: daily?.temperatureMin ?? null,
      condition: daily?.condition ?? "unknown" as WeatherCondition,
      available: Boolean(daily && validProbability(daily.precipitationProbability)),
    }];
  });
  const forecasts: CapturedProviderForecast[] = providerRows.flatMap((provider) =>
    provider.available
      ? [{ provider: provider.id, probability: provider.probability, amountMm: provider.amountMm }]
      : [],
  );
  const performance = await performancePromise;
  // Learned influence is evidence for one cohort's next day, so only the target
  // date operates under the profile; later outlook days stay on Equal Fallback.
  const operatingProfile =
    performance.status === "active" ? performance.profile : null;
  const effectiveInfluence = blendPrecipitation(forecasts, operatingProfile).influence;
  const outlook = Array.from(
    new Set(
      snapshots.flatMap((snapshot) => snapshot.daily.map((day) => day.date))
        .filter((date) => date >= targetDate),
    ),
  )
    .sort()
    .slice(0, 7)
    .flatMap((date) => {
      const day = buildForecastDay(date, snapshots, date === targetDate ? operatingProfile : null);
      return day ? [day] : [];
    });
  const recommendation = buildForecastDay(targetDate, snapshots, operatingProfile) ?? {
    date: targetDate,
    precipitationProbability: null,
    precipitationAmountMm: null,
    temperatureMax: null,
    temperatureMin: null,
    condition: "unknown" as const,
  };
  const currentSource = snapshots.find((snapshot) => snapshot.current !== null);
  // Equal weighting on purpose — see the `today` field docs.
  const today = buildForecastDay(koreanDate(now), snapshots, null);
  return {
    generatedAt: now.toISOString(),
    location: input.location,
    targetDate,
    captureCohort: cohort,
    current: currentSource?.current
      ? {
          temperature: currentSource.current.temperature,
          apparentTemperature: currentSource.current.apparentTemperature,
          condition: currentSource.current.condition,
          observedAt: currentSource.current.time,
          sourceName: currentSource.status.name,
        }
      : null,
    recommendation: {
      precipitationProbability: recommendation.precipitationProbability,
      precipitationAmountMm: recommendation.precipitationAmountMm,
      temperatureMax: recommendation.temperatureMax,
      temperatureMin: recommendation.temperatureMin,
      condition: recommendation.condition,
    },
    today,
    outlook,
    providers: providerRows.map((provider) => ({
      id: provider.id,
      name: provider.name,
      probability: provider.probability,
      amountMm: provider.amountMm,
      available: provider.available,
    })),
    effectiveInfluence,
    performance,
  };
}
