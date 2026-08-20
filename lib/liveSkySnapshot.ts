import { seoulDateStr } from "./format.ts";
import { gatePrecipWeighting } from "./reliability/runtimeWeights.ts";
import {
  chooseCurrent,
  fuseMultiSourceDaily,
  reweightForecastPrecip,
  type SourceDailyForecast,
} from "./skyFusion.ts";
import type {
  CurrentWeather,
  DailyForecast,
  HourlyForecast,
  NormalizedAirQuality,
  NormalizedWarning,
  ProviderId,
  SkyRadar,
  SkySnapshot,
  WeatherProviderStatus,
} from "./types.ts";
import type { WeightsState } from "./reliability/types.ts";

const PRECIP_FORECAST_SOURCES: ProviderId[] = ["open-meteo"];

export interface OpenMeteoRead {
  current: CurrentWeather;
  hourly: HourlyForecast[];
  daily: DailyForecast[];
  status: WeatherProviderStatus;
}

/** Dependencies are explicit so the public snapshot can be tested without HTTP or live providers. */
export interface LiveSkyDependencies {
  getOpenMeteo(): Promise<OpenMeteoRead>;
  getAir(): Promise<NormalizedAirQuality | null>;
  getRadar(): Promise<SkyRadar | null>;
  getKmaCurrent(): Promise<CurrentWeather | null>;
  getWarnings(): Promise<NormalizedWarning[]>;
  getWeightsState(): Promise<WeightsState | null>;
  getForecastSources(): Promise<SourceDailyForecast[]>;
}

export interface LiveSkySnapshotOptions {
  now(): Date;
  multiSourcePrecip: boolean;
  reliabilityDebug: boolean;
}

/**
 * Assemble the public `/api/sky` snapshot. This is the live-data boundary; the route
 * is deliberately only an HTTP adapter around this function.
 */
export async function readLiveSkySnapshot(
  dependencies: LiveSkyDependencies,
  options: LiveSkySnapshotOptions,
): Promise<SkySnapshot> {
  const [openMeteo, air, radar, kmaCurrent, warnings, weightsState, forecastSources] = await Promise.all([
    dependencies.getOpenMeteo(),
    dependencies.getAir(),
    dependencies.getRadar(),
    dependencies.getKmaCurrent(),
    dependencies.getWarnings(),
    options.multiSourcePrecip ? dependencies.getWeightsState() : Promise.resolve<WeightsState | null>(null),
    options.multiSourcePrecip ? dependencies.getForecastSources() : Promise.resolve<SourceDailyForecast[]>([]),
  ]);
  const { current, hourly, daily, status } = openMeteo;
  const now = options.now();
  const todaySun = daily.find((day) => day.date === seoulDateStr(now)) ?? daily[0] ?? null;

  const multiSource = options.multiSourcePrecip && forecastSources.length > 0;
  const weightSources = multiSource ? forecastSources.map((source) => source.source) : PRECIP_FORECAST_SOURCES;
  const weighting = gatePrecipWeighting(weightsState, weightSources, now);
  const precipLearning: SkySnapshot["precipLearning"] = options.multiSourcePrecip
    ? {
        enabled: true,
        multiSource: weightSources.length > 1,
        mode: weighting.mode,
        reason: weighting.reason,
        confidence: weighting.confidence,
        eventsScored: weightsState?.eventsScored ?? 0,
        datesScored: weightsState?.processedDates.length ?? 0,
        updatedAt: weightsState?.updatedAt ?? null,
        sources: weightSources,
        effectiveWeights: weighting.weights,
        learnedWeights: { ...(weightsState?.weights ?? {}) },
      }
    : {
        enabled: false,
        multiSource: false,
        mode: "equal-fallback",
        reason: "disabled",
        confidence: 0,
        eventsScored: 0,
        datesScored: 0,
        updatedAt: null,
        sources: PRECIP_FORECAST_SOURCES,
        effectiveWeights: { "open-meteo": 1 },
        learnedWeights: {},
      };
  const single = reweightForecastPrecip(
    { daily, hourly, currentPrecipitationProbability: current.precipitationProbability ?? null },
    "open-meteo",
    weighting.weights,
  );
  const weightedPrecip = multiSource
    ? { ...single, daily: fuseMultiSourceDaily(daily, forecastSources, weighting.weights) }
    : single;
  const choice = chooseCurrent(
    {
      temperature: current.temperature,
      condition: current.condition,
      precipitation: current.precipitation ?? 0,
    },
    kmaCurrent,
  );
  const sources: ProviderId[] = ["open-meteo"];
  if (kmaCurrent) sources.push("kma");
  if (air) sources.push(air.source);
  if (radar) sources.push("rainviewer");

  return {
    observedAt: kmaCurrent?.time ?? current.time,
    fetchedAt: now.toISOString(),
    fromCache: status.fromCache,
    stale: status.stale ?? false,
    current: {
      temperature: choice.temperature,
      apparentTemperature: current.apparentTemperature,
      humidity: current.humidity,
      windSpeed: current.windSpeed,
      windGusts: current.windGusts ?? null,
      windDirection: current.windDirection,
      precipitation: choice.precipitation,
      rain: current.rain ?? null,
      snowfall: current.snowfall ?? null,
      precipitationProbability: weightedPrecip.currentPrecipitationProbability,
      cloudCover: current.cloudCover,
      visibility: current.visibility ?? null,
      isDay: current.isDay ?? null,
      weatherCode: current.weatherCode ?? null,
      condition: choice.condition,
    },
    sun: { sunrise: todaySun?.sunrise ?? null, sunset: todaySun?.sunset ?? null },
    hourly: weightedPrecip.hourly,
    daily: weightedPrecip.daily,
    air,
    radar,
    warnings,
    observationSource: choice.temperatureSource,
    sources,
    precipLearning,
    ...(options.reliabilityDebug
      ? {
          precipWeighting: {
            mode: weighting.mode,
            reason: weighting.reason,
            confidence: weighting.confidence,
            multiSource,
            sources: weightSources,
            weights: weighting.weights,
          },
        }
      : {}),
  };
}
