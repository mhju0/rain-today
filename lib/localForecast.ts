import type { ForecastLocation } from "./location.ts";
import {
  blendPrecipProbability,
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

export interface LocalForecastResponse {
  generatedAt: string;
  location: ForecastLocation;
  targetDate: string | null;
  captureCohort: CaptureCohort;
  recommendation: {
    precipitationProbability: number | null;
    precipitationAmountMm: number | null;
    temperatureMax: number | null;
    temperatureMin: number | null;
    condition: WeatherCondition;
  };
  outlook: Array<{
    date: string;
    precipitationProbability: number | null;
    precipitationAmountMm: number | null;
    temperatureMax: number | null;
    temperatureMin: number | null;
    condition: WeatherCondition;
  }>;
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

function equalInfluence(forecasts: readonly CapturedProviderForecast[]): Record<string, number> {
  const weight = forecasts.length > 0 ? 1 / forecasts.length : 0;
  return Object.fromEntries(forecasts.map((forecast) => [forecast.provider, weight]));
}

function normalizeInfluence(
  forecasts: readonly CapturedProviderForecast[],
  weights: Readonly<Record<string, number>>,
): Record<string, number> {
  const present = Object.fromEntries(
    forecasts.map((forecast) => [
      forecast.provider,
      Math.max(0, weights[forecast.provider] ?? DEFAULT_PERFORMANCE_POLICY.weightFloor),
    ]),
  );
  const total = Object.values(present).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return equalInfluence(forecasts);
  return Object.fromEntries(
    Object.entries(present).map(([provider, value]) => [provider, value / total]),
  );
}

function buildForecastDay(
  date: string,
  snapshots: readonly ProviderSnapshot[],
  weights: Readonly<Record<string, number>>,
): LocalForecastResponse["outlook"][number] | null {
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
  const influence = normalizeInfluence(forecasts, weights);
  const amounts = forecasts.filter((forecast) => forecast.amountMm !== null);
  const amountWeight = amounts.reduce(
    (sum, forecast) => sum + (influence[forecast.provider] ?? 0),
    0,
  );
  return {
    date,
    precipitationProbability: blendPrecipProbability(forecasts, influence),
    precipitationAmountMm:
      amountWeight > 0
        ? amounts.reduce(
            (sum, forecast) =>
              sum + forecast.amountMm! * (influence[forecast.provider] ?? 0) / amountWeight,
            0,
          )
        : null,
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
  const effectiveInfluence = normalizeInfluence(
    forecasts,
    performance.status === "active" && performance.profile
      ? performance.profile.effectiveWeights
      : equalInfluence(forecasts),
  );
  const operatingWeights =
    performance.status === "active" && performance.profile
      ? performance.profile.effectiveWeights
      : {};
  const outlook = Array.from(
    new Set(
      snapshots.flatMap((snapshot) => snapshot.daily.map((day) => day.date))
        .filter((date) => date >= targetDate),
    ),
  )
    .sort()
    .slice(0, 7)
    .flatMap((date) => {
      const day = buildForecastDay(
        date,
        snapshots,
        date === targetDate ? operatingWeights : {},
      );
      return day ? [day] : [];
    });
  const recommendation = buildForecastDay(targetDate, snapshots, operatingWeights) ?? {
    date: targetDate,
    precipitationProbability: null,
    precipitationAmountMm: null,
    temperatureMax: null,
    temperatureMin: null,
    condition: "unknown" as const,
  };
  return {
    generatedAt: now.toISOString(),
    location: input.location,
    targetDate,
    captureCohort: cohort,
    recommendation: {
      precipitationProbability: recommendation.precipitationProbability,
      precipitationAmountMm: recommendation.precipitationAmountMm,
      temperatureMax: recommendation.temperatureMax,
      temperatureMin: recommendation.temperatureMin,
      condition: recommendation.condition,
    },
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
