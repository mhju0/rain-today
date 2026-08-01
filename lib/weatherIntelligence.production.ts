import "server-only";

import { airQualityStatuses, getFusedAirQuality } from "./providers/air-quality";
import { getKmaWarningStatus, getKmaWarnings } from "./providers/kma";
import { getRadarSummary, radarStatus } from "./providers/radar";
import { providers } from "./providers/registry";
import {
  readWeatherIntelligence,
  type WeatherIntelligenceDependencies,
  type WeatherIntelligenceOptions,
} from "./weatherIntelligence";
import type { WeatherIntelligence } from "./types";

const dependencies: WeatherIntelligenceDependencies = {
  // Promise.all in the core keeps this registry order, which defines primary.
  providerReads: providers.map((provider) => () => provider.read()),
  async getEnvironment() {
    const [air, radar, airStatuses, warningStatus, radarSourceStatus] = await Promise.all([
      getFusedAirQuality(),
      getRadarSummary(),
      airQualityStatuses(),
      getKmaWarningStatus(),
      radarStatus(),
    ]);
    return {
      statuses: [...airStatuses, warningStatus, radarSourceStatus],
      air,
      radar,
    };
  },
  getWarnings: getKmaWarnings,
};

const options: WeatherIntelligenceOptions = {
  now: () => new Date(),
};

export function readProductionWeatherIntelligence(): Promise<WeatherIntelligence> {
  return readWeatherIntelligence(dependencies, options);
}
