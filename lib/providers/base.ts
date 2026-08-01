import type {
  CurrentWeather,
  DailyForecast,
  HourlyForecast,
  ProviderSnapshot,
  WeatherProviderStatus,
} from "../types";

/** One upstream response normalized into every forecast view consumers need. */
export interface NormalizedForecast {
  current: CurrentWeather;
  hourly: HourlyForecast[];
  daily: DailyForecast[];
}

/**
 * Contract every weather source must implement.
 *
 * Implementations fetch their upstream API once per cache window (see
 * lib/cache.ts) and return all normalized views in one read. Methods may throw;
 * lib/providers/read.ts is the failure-isolating seam for every consumer.
 */
export interface WeatherProvider {
  readonly id: WeatherProviderStatus["id"];
  /** Korean display name */
  readonly name: string;
  read(): Promise<ProviderSnapshot>;
}
