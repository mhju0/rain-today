import type { KoreanLocation } from "../location.ts";
import type { ProviderSnapshot } from "../types.ts";
import { captureStationForecast } from "./capture.ts";
import { fetchAsosObservation, fetchKmaAsosStations } from "./kma.ts";
import type { PerformanceStore } from "./store.ts";
import type {
  CaptureCohort,
  ObservationStation,
  PrecipObservation,
} from "./types.ts";

export interface PerformanceBatchFailure {
  stationId: string;
  phase: "observation" | "capture";
  message: string;
}

export interface PerformanceBatchResult {
  stationCount: number;
  observationsStored: number;
  capturesInserted: number;
  capturesExisting: number;
  capturesSkipped: number;
  failures: PerformanceBatchFailure[];
}

interface PerformanceBatchInput {
  cohort: CaptureCohort;
  now: Date;
  store: PerformanceStore;
  fetchStations?: (at: Date) => Promise<ObservationStation[]>;
  fetchObservation?: (
    stationId: string,
    date: string,
    now: Date,
  ) => Promise<PrecipObservation | null>;
  readForecasts?: (location: KoreanLocation) => Promise<ProviderSnapshot[]>;
  concurrency?: number;
}

function koreanDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function previousCalendarDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/** Run one bounded nationwide ASOS observation-and-capture cohort. */
export async function runPerformanceBatch(
  input: PerformanceBatchInput,
): Promise<PerformanceBatchResult> {
  await input.store.initialize();
  const stations = await (input.fetchStations ?? fetchKmaAsosStations)(input.now);
  await input.store.upsertStations(stations);
  const result: PerformanceBatchResult = {
    stationCount: stations.length,
    observationsStored: 0,
    capturesInserted: 0,
    capturesExisting: 0,
    capturesSkipped: 0,
    failures: [],
  };
  const observationDate = previousCalendarDate(koreanDate(input.now));
  const fetchObservation = input.fetchObservation ?? fetchAsosObservation;
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < stations.length) {
      const station = stations[nextIndex++];
      try {
        const observation = await fetchObservation(station.id, observationDate, input.now);
        if (observation) {
          await input.store.saveObservation(observation);
          result.observationsStored += 1;
        }
      } catch (error) {
        result.failures.push({
          stationId: station.id,
          phase: "observation",
          message: failureMessage(error),
        });
      }

      try {
        const capture = await captureStationForecast({
          station,
          cohort: input.cohort,
          now: input.now,
          store: input.store,
          readForecasts: input.readForecasts,
        });
        if (capture.status === "inserted") result.capturesInserted += 1;
        if (capture.status === "existing") result.capturesExisting += 1;
        if (capture.status === "skipped") result.capturesSkipped += 1;
      } catch (error) {
        result.failures.push({
          stationId: station.id,
          phase: "capture",
          message: failureMessage(error),
        });
      }
    }
  };

  const concurrency = Math.max(1, Math.min(input.concurrency ?? 4, stations.length || 1));
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return result;
}
