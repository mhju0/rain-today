import { createKoreanLocation, type KoreanLocation } from "../location.ts";
import { providers as weatherProviders } from "../providers/registry.ts";
import type { ProviderSnapshot } from "../types.ts";
import { buildLocalPerformanceProfile, DEFAULT_PERFORMANCE_POLICY } from "./performance.ts";
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
  readForecasts?: (location: KoreanLocation) => Promise<ProviderSnapshot[]>;
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

function normalizedInfluence(
  forecasts: readonly CapturedProviderForecast[],
  profileWeights: Readonly<Record<string, number>>,
): Record<string, number> {
  const raw = Object.fromEntries(
    forecasts.map((forecast) => [
      forecast.provider,
      Math.max(
        0,
        profileWeights[forecast.provider] ?? DEFAULT_PERFORMANCE_POLICY.weightFloor,
      ),
    ]),
  );
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    const equal = 1 / forecasts.length;
    return Object.fromEntries(forecasts.map((forecast) => [forecast.provider, equal]));
  }
  return Object.fromEntries(
    Object.entries(raw).map(([provider, weight]) => [provider, weight / total]),
  );
}

async function readAllForecasts(location: KoreanLocation): Promise<ProviderSnapshot[]> {
  return Promise.all(weatherProviders.map((provider) => provider.read(location)));
}

/** Freeze one station's next-day provider predictions before the outcome exists. */
export async function captureStationForecast(
  input: CaptureStationInput,
): Promise<CaptureStationResult> {
  const targetDate = addCalendarDays(koreanDate(input.now), 1);
  const location = createKoreanLocation({
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

  const [captures, observations] = await Promise.all([
    input.store.loadCaptures(input.station.id, input.cohort),
    input.store.loadObservations(input.station.id),
  ]);
  const profile = buildLocalPerformanceProfile({
    stationId: input.station.id,
    cohort: input.cohort,
    captures,
    observations,
    asOf: input.now,
  });
  const influence = normalizedInfluence(
    forecasts,
    profile.mode === "learned" || profile.mode === "ramping"
      ? profile.effectiveWeights
      : {},
  );
  const equalProbability =
    forecasts.reduce((sum, forecast) => sum + forecast.probability!, 0) / forecasts.length;
  const adaptiveProbability = forecasts.reduce(
    (sum, forecast) => sum + forecast.probability! * influence[forecast.provider],
    0,
  );
  const capture: ForecastCapture = {
    stationId: input.station.id,
    targetDate,
    cohort: input.cohort,
    capturedAt: input.now.toISOString(),
    providers: forecasts,
    frozenBlend: { adaptiveProbability, equalProbability, influence },
  };
  const status = await input.store.saveCapture(capture);
  return {
    status,
    reason: status === "inserted" ? "captured" : "already-captured",
    capture,
  };
}
