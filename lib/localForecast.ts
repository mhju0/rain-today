import type { KoreanLocation } from "./location.ts";
import { blendPrecipProbability, buildLocalPerformanceProfile } from "./performance/performance.ts";
import { PostgresPerformanceStore } from "./performance/postgres.ts";
import { selectObservationStation } from "./performance/stations.ts";
import type {
  CaptureCohort,
  CapturedProviderForecast,
  LocalPerformanceProfile,
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

export interface LocalForecastEvidence {
  status: "active" | "collecting" | "unavailable";
  reason:
    | "eligible-station"
    | "insufficient-evidence"
    | "no-eligible-station"
    | "database-not-configured"
    | "database-unavailable";
  station: { id: string; name: string; distanceKm: number } | null;
  profile: LocalPerformanceProfile | null;
}

export interface LocalForecastResponse {
  generatedAt: string;
  location: KoreanLocation;
  targetDate: string | null;
  captureCohort: CaptureCohort;
  recommendation: {
    precipitationProbability: number | null;
    precipitationAmountMm: number | null;
    temperatureMax: number | null;
    temperatureMin: number | null;
    condition: WeatherCondition;
  };
  providers: Array<{
    id: PrecipProviderId;
    name: string;
    probability: number | null;
    amountMm: number | null;
    available: boolean;
  }>;
  providerInfluence: Record<string, number>;
  performance: LocalForecastEvidence;
}

interface LocalForecastDependencies {
  now?: Date;
  readForecasts?: (location: KoreanLocation) => Promise<ProviderSnapshot[]>;
  readEvidence?: (
    location: KoreanLocation,
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
    forecasts.map((forecast) => [forecast.provider, Math.max(0, weights[forecast.provider] ?? 0)]),
  );
  const total = Object.values(present).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return equalInfluence(forecasts);
  return Object.fromEntries(
    Object.entries(present).map(([provider, value]) => [provider, value / total]),
  );
}

async function readAllForecasts(location: KoreanLocation): Promise<ProviderSnapshot[]> {
  return Promise.all(weatherProviders.map((provider) => provider.read(location)));
}

export async function readDatabaseEvidence(
  location: KoreanLocation,
  elevationM: number | null,
  cohort: CaptureCohort,
  now: Date,
): Promise<LocalForecastEvidence> {
  const connectionUrl = process.env.PERFORMANCE_DATABASE_URL?.trim();
  if (!connectionUrl) {
    return { status: "unavailable", reason: "database-not-configured", station: null, profile: null };
  }
  const store = new PostgresPerformanceStore(connectionUrl);
  try {
    await store.initialize();
    const selection = selectObservationStation({
      location: { ...location, elevationM },
      stations: await store.listStations(),
      at: now,
      policy: STATION_POLICY,
    });
    if (!selection.station || selection.distanceKm === null) {
      return { status: "unavailable", reason: "no-eligible-station", station: null, profile: null };
    }
    const [captures, observations] = await Promise.all([
      store.loadCaptures(selection.station.id, cohort),
      store.loadObservations(selection.station.id),
    ]);
    const profile = buildLocalPerformanceProfile({
      stationId: selection.station.id,
      cohort,
      captures,
      observations,
      asOf: now,
    });
    const active = profile.mode === "learned" || profile.mode === "ramping";
    return {
      status: active ? "active" : "collecting",
      reason: active ? "eligible-station" : "insufficient-evidence",
      station: {
        id: selection.station.id,
        name: selection.station.name,
        distanceKm: Math.round(selection.distanceKm * 10) / 10,
      },
      profile,
    };
  } catch {
    return { status: "unavailable", reason: "database-unavailable", station: null, profile: null };
  } finally {
    await store.close().catch(() => undefined);
  }
}

/** Build the user-facing exact-location forecast with nearby-station evidence. */
export async function readLocalForecast(
  input: { location: KoreanLocation; elevationM: number | null },
  dependencies: LocalForecastDependencies = {},
): Promise<LocalForecastResponse> {
  const now = dependencies.now ?? new Date();
  const cohort = captureCohortAt(now);
  const snapshots = await (dependencies.readForecasts ?? readAllForecasts)(input.location);
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
  const performance = await (dependencies.readEvidence ?? readDatabaseEvidence)(
    input.location,
    input.elevationM,
    cohort,
    now,
  );
  const providerInfluence = normalizeInfluence(
    forecasts,
    performance.status === "active" && performance.profile
      ? performance.profile.effectiveWeights
      : equalInfluence(forecasts),
  );
  const primary = providerRows.find((provider) => provider.available) ?? providerRows[0];
  const amounts = forecasts.filter((forecast) => forecast.amountMm !== null);
  const amountWeight = amounts.reduce(
    (sum, forecast) => sum + (providerInfluence[forecast.provider] ?? 0),
    0,
  );
  return {
    generatedAt: now.toISOString(),
    location: input.location,
    targetDate,
    captureCohort: cohort,
    recommendation: {
      precipitationProbability: blendPrecipProbability(forecasts, providerInfluence),
      precipitationAmountMm:
        amountWeight > 0
          ? amounts.reduce(
              (sum, forecast) =>
                sum + forecast.amountMm! * (providerInfluence[forecast.provider] ?? 0) / amountWeight,
              0,
            )
          : null,
      temperatureMax: primary?.temperatureMax ?? null,
      temperatureMin: primary?.temperatureMin ?? null,
      condition: primary?.condition ?? "unknown",
    },
    providers: providerRows.map((provider) => ({
      id: provider.id,
      name: provider.name,
      probability: provider.probability,
      amountMm: provider.amountMm,
      available: provider.available,
    })),
    providerInfluence,
    performance,
  };
}
