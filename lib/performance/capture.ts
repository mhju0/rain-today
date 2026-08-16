import { createForecastLocation, type ForecastLocation } from "../location.ts";
import { providers as weatherProviders } from "../providers/registry.ts";
import type { ProviderSnapshot } from "../types.ts";
import { blendPrecipitation } from "./influence.ts";
import { buildRecentPerformanceProfile, DEFAULT_PERFORMANCE_POLICY } from "./performance.ts";
import type { PerformanceStore } from "./store.ts";
import type {
  CaptureCohort,
  CapturedProviderForecast,
  ForecastCapture,
  ObservationStation,
  PrecipProviderId,
} from "./types.ts";

const PRECIP_PROVIDERS = new Set<PrecipProviderId>([
  "open-meteo",
  "met-norway",
  "kma",
  "pirate-weather",
  "weather-api",
]);

export interface CaptureStationInput {
  station: ObservationStation;
  cohort: CaptureCohort;
  now: Date;
  store: PerformanceStore;
  readForecasts?: (location: ForecastLocation) => Promise<ProviderSnapshot[]>;
}

export interface CaptureStationResult {
  status: "inserted" | "existing" | "skipped";
  reason: "captured" | "already-captured" | "no-next-day-probability";
  capture: ForecastCapture | null;
}

function koreanDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addCalendarDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function validProbability(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 100;
}

function validAmount(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

async function readAllForecasts(location: ForecastLocation): Promise<ProviderSnapshot[]> {
  return Promise.all(weatherProviders.map((provider) => provider.read(location)));
}

/** Freeze one station's next-day provider predictions before the outcome exists. */
export async function captureStationForecast(
  input: CaptureStationInput,
): Promise<CaptureStationResult> {
  const targetDate = addCalendarDays(koreanDate(input.now), 1);
  const location = createForecastLocation({
    name: input.station.name,
    latitude: input.station.latitude,
    longitude: input.station.longitude,
  });
  const snapshots = await (input.readForecasts ?? readAllForecasts)(location);
  const forecasts = snapshots.flatMap((snapshot): CapturedProviderForecast[] => {
    if (!PRECIP_PROVIDERS.has(snapshot.id as PrecipProviderId)) return [];
    const daily = snapshot.daily.find((day) => day.date === targetDate);
    if (!daily || !validProbability(daily.precipitationProbability)) return [];
    return [{
      provider: snapshot.id as PrecipProviderId,
      probability: daily.precipitationProbability,
      amountMm: validAmount(daily.precipitationAmount),
    }];
  });
  if (forecasts.length === 0) {
    return { status: "skipped", reason: "no-next-day-probability", capture: null };
  }

  const comparisons = await input.store.loadCompletedComparisons(
    input.station.id,
    input.cohort,
    DEFAULT_PERFORMANCE_POLICY.fullInfluenceSamples,
  );
  const profile = buildRecentPerformanceProfile({
    stationId: input.station.id,
    cohort: input.cohort,
    captures: comparisons.map((comparison) => comparison.capture),
    observations: comparisons.map((comparison) => comparison.observation),
    asOf: input.now,
  });
  // Both blends come from the module the serving path uses, so the Prospective
  // Benchmark compares the adaptive and equal probabilities a user would have
  // been shown rather than two separately derived numbers.
  const adaptive = blendPrecipitation(forecasts, profile);
  const equal = blendPrecipitation(forecasts, null);
  const capture: ForecastCapture = {
    stationId: input.station.id,
    targetDate,
    cohort: input.cohort,
    capturedAt: input.now.toISOString(),
    providers: forecasts,
    frozenBlend: {
      adaptiveProbability: adaptive.probability,
      equalProbability: equal.probability,
      influence: adaptive.influence,
    },
  };
  const status = await input.store.saveCapture(capture);
  return {
    status,
    reason: status === "inserted" ? "captured" : "already-captured",
    capture,
  };
}
