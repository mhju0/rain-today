import type {
  CurrentWeather,
  DailyForecast,
  HourlyForecast,
  ProviderSnapshot,
  WeatherProviderStatus,
} from "../types.ts";
import type { ForecastLocation } from "../location.ts";

/** One upstream response normalized into every forecast view consumers need. */
export interface NormalizedForecast {
  current: CurrentWeather;
  hourly: HourlyForecast[];
  daily: DailyForecast[];
}

/**
 * Contract every weather source must implement.
 *
 * Providers created by lib/providers/read.ts cache one upstream load per window
 * and isolate failures as non-ok snapshots. Consumers receive every normalized
 * view and the status describing that same cached generation in one read.
 */
export interface WeatherProvider {
  readonly id: WeatherProviderStatus["id"];
  /** Korean display name */
  readonly name: string;
  read(location?: ForecastLocation): Promise<ProviderSnapshot>;
}
