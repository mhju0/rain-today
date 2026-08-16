import { cachedFetch } from "../cache.ts";
import {
  DEFAULT_FORECAST_LOCATION,
  forecastLocationCacheKey,
  type ForecastLocation,
} from "../location.ts";
import type { DailyForecast, ProviderSnapshot, WeatherProviderStatus } from "../types.ts";
import type { NormalizedForecast, WeatherProvider } from "./base.ts";

export interface AvailableProviderDaily {
  source: WeatherProvider["id"];
  daily: DailyForecast[];
}

export interface ProviderMessages {
  ok: string;
  stale: string;
  needsConfig: string;
  error: string;
}

export interface WeatherProviderDefinition {
  id: WeatherProviderStatus["id"];
  name: string;
  statusName?: string;
  messages: ProviderMessages;
  missingConfiguration(): string[];
  ttlMs: number;
  load(location: ForecastLocation): Promise<NormalizedForecast>;
  failureMessage?(error: unknown): string;
}

function emptySnapshot(id: WeatherProviderStatus["id"], status: WeatherProviderStatus): ProviderSnapshot {
  return { id, status, current: null, hourly: [], daily: [] };
}

function failureMessage(definition: WeatherProviderDefinition, error: unknown): string {
  try {
    return definition.failureMessage?.(error) ?? definition.messages.error;
  } catch {
    return definition.messages.error;
  }
}

/** Create one provider boundary that reads coherent status and weather together. */
export function createWeatherProvider(definition: WeatherProviderDefinition): WeatherProvider {
  const cacheKey = definition.id;
  const statusName = definition.statusName ?? definition.name;

  return {
    id: definition.id,
    name: definition.name,

    async read(location = DEFAULT_FORECAST_LOCATION): Promise<ProviderSnapshot> {
      try {
        const missingEnvVars = definition.missingConfiguration();
        if (missingEnvVars.length > 0) {
          return emptySnapshot(definition.id, {
            id: definition.id,
            name: statusName,
            availability: "needs-config",
            message: definition.messages.needsConfig,
            missingEnvVars,
            lastUpdated: null,
            fromCache: false,
          });
        }

        const result = await cachedFetch(
          `${cacheKey}:${forecastLocationCacheKey(location)}`,
          definition.ttlMs,
          () => definition.load(location),
        );
        return {
          id: definition.id,
          status: {
            id: definition.id,
            name: statusName,
            availability: "ok",
            message: result.stale ? definition.messages.stale : definition.messages.ok,
            missingEnvVars: [],
            lastUpdated: result.value.current.time,
            fromCache: result.fromCache,
            stale: result.stale,
          },
          ...result.value,
        };
      } catch (error) {
        return emptySnapshot(definition.id, {
          id: definition.id,
          name: statusName,
          availability: "error",
          message: failureMessage(definition, error),
          missingEnvVars: [],
          lastUpdated: null,
          fromCache: false,
        });
      }
    },
  };
}

/**
 * Read one provider's daily forecast for callers that intentionally omit an
 * unavailable or failing optional source from a consensus or batch run.
 */
export async function readAvailableProviderDaily(
  provider: WeatherProvider,
  location: ForecastLocation = DEFAULT_FORECAST_LOCATION,
): Promise<AvailableProviderDaily | null> {
  const snapshot = await provider.read(location);
  return snapshot.status.availability === "ok"
    ? { source: snapshot.id, daily: snapshot.daily }
    : null;
}
