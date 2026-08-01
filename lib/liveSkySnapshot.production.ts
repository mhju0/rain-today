import "server-only";

import { getFusedAirQuality } from "./providers/air-quality";
import { getKmaWarnings, kmaProvider } from "./providers/kma";
import { openMeteoProvider } from "./providers/open-meteo";
import { getSkyRadar } from "./providers/radar";
import { multiSourcePrecipEnabled } from "./reliability/config";
import { collectForecastSources } from "./reliability/forecastSources";
import { loadWeightsStateCached } from "./reliability/runtimeWeightsSource";
import {
  readLiveSkySnapshot,
  type LiveSkyDependencies,
  type LiveSkySnapshotOptions,
} from "./liveSkySnapshot";
import type { CurrentWeather, SkySnapshot } from "./types";

async function getKmaCurrent(): Promise<CurrentWeather | null> {
  const snapshot = await kmaProvider.read();
  return snapshot.status.availability === "ok" ? snapshot.current : null;
}

const dependencies: LiveSkyDependencies = {
  async getOpenMeteo() {
    const snapshot = await openMeteoProvider.read();
    if (snapshot.status.availability !== "ok" || snapshot.current === null) {
      throw new Error("Open-Meteo forecast unavailable");
    }
    return {
      current: snapshot.current,
      hourly: snapshot.hourly,
      daily: snapshot.daily,
      status: snapshot.status,
    };
  },
  getAir: getFusedAirQuality,
  getRadar: getSkyRadar,
  getKmaCurrent,
  getWarnings: getKmaWarnings,
  getWeightsState: loadWeightsStateCached,
  getForecastSources: collectForecastSources,
};

const options: LiveSkySnapshotOptions = {
  now: () => new Date(),
  multiSourcePrecip: multiSourcePrecipEnabled(process.env.MULTI_SOURCE_PRECIP),
  reliabilityDebug: process.env.RELIABILITY_DEBUG === "1",
};

export function readProductionLiveSkySnapshot(): Promise<SkySnapshot> {
  return readLiveSkySnapshot(dependencies, options);
}
