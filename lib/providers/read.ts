import { cachedFetch } from "../cache.ts";
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
  messages: ProviderMessages;
  missingConfiguration(): string[];
  ttlMs: number;
  load(): Promise<NormalizedForecast>;
}

function emptySnapshot(id: WeatherProviderStatus["id"], status: WeatherProviderStatus): ProviderSnapshot {
  return { id, status, current: null, hourly: [], daily: [] };
}

/** Create one provider boundary that reads coherent status and weather together. */
export function createWeatherProvider(definition: WeatherProviderDefinition): WeatherProvider {
  const cacheKey = definition.id;
  const errorMessage = definition.messages.error;

  return {
    id: definition.id,
    name: definition.name,

    async read(): Promise<ProviderSnapshot> {
      try {
        const missingEnvVars = definition.missingConfiguration();
        if (missingEnvVars.length > 0) {
          return emptySnapshot(definition.id, {
            id: definition.id,
            name: definition.name,
            availability: "needs-config",
            message: definition.messages.needsConfig,
            missingEnvVars,
            lastUpdated: null,
            fromCache: false,
          });
        }

        const result = await cachedFetch(cacheKey, definition.ttlMs, definition.load);
        return {
          id: definition.id,
          status: {
            id: definition.id,
            name: definition.name,
            availability: "ok",
            message: result.stale ? definition.messages.stale : definition.messages.ok,
            missingEnvVars: [],
            lastUpdated: result.value.current.time,
            fromCache: result.fromCache,
            stale: result.stale,
          },
          ...result.value,
        };
      } catch {
        return emptySnapshot(definition.id, {
          id: definition.id,
          name: definition.name,
          availability: "error",
          message: errorMessage,
          missingEnvVars: [],
          lastUpdated: null,
          fromCache: false,
        });
      }
    },
  };
}

/** Compatibility seam for callers that need a provider's complete snapshot. */
export async function readProviderSnapshot(provider: WeatherProvider): Promise<ProviderSnapshot> {
  return provider.read();
}

/**
 * Read one provider's daily forecast for callers that intentionally omit an
 * unavailable or failing optional source from a consensus or batch run.
 */
export async function readAvailableProviderDaily(provider: WeatherProvider): Promise<AvailableProviderDaily | null> {
  const snapshot = await provider.read();
  return snapshot.status.availability === "ok"
    ? { source: snapshot.id, daily: snapshot.daily }
    : null;
}
