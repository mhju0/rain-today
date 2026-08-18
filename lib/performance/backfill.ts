import { buildSeedComparisons, MAX_SEED_RANGE_DAYS } from "./seed.ts";
import type { PerformanceStore } from "./store.ts";
import type { ObservationStation, SeedComparison } from "./types.ts";

/**
 * One-shot retrospective backfill: rebuild Seed Comparisons for a set of stations
 * over a past date range and store them.
 *
 * This runs offline, not on a visitor's clock, and is idempotent — the store
 * ignores a (station, date) it already holds, so a re-run after a partial failure
 * costs only the re-fetch. A station whose window fails is recorded and skipped
 * rather than aborting the run: partial nationwide evidence is useful, and a
 * fabricated substitute would not be.
 */

/** Calendar months keep each provider response small and isolate partial failure. */
export function chunkMonths(startDate: string, endDate: string): [string, string][] {
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  const chunks: [string, string][] = [];
  let cursor = Date.parse(`${startDate}T00:00:00.000Z`);
  if (!Number.isFinite(cursor) || !Number.isFinite(end) || cursor > end) return chunks;

  while (cursor <= end) {
    const from = new Date(cursor);
    const monthEnd = Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0);
    const to = Math.min(monthEnd, end);
    chunks.push([
      new Date(cursor).toISOString().slice(0, 10),
      new Date(to).toISOString().slice(0, 10),
    ]);
    cursor = to + 86_400_000;
  }
  return chunks;
}

/**
 * Union a partial station list into the currently active catalog.
 *
 * The backfill only needs its target stations to EXIST; it is not an authority on
 * which stations are active. Passing a partial list straight to `syncStations`
 * would declare every other station retired — the catalog drop guard refuses that,
 * so a fallback-catalog backfill would simply fail against a populated database.
 */
export function mergeStationCatalog(
  existing: readonly ObservationStation[],
  additions: readonly ObservationStation[],
): ObservationStation[] {
  const active = new Map(
    existing.filter((station) => station.activeTo === null).map((station) => [station.id, station]),
  );
  for (const station of additions) active.set(station.id, station);
  return Array.from(active.values()).sort((a, b) => Number(a.id) - Number(b.id));
}

export interface BackfillFailure {
  stationId: string;
  window: string;
  message: string;
}

export interface BackfillResult {
  stationCount: number;
  windowCount: number;
  comparisonsBuilt: number;
  comparisonsStored: number;
  failures: BackfillFailure[];
}

export interface BackfillRequest {
  stations: readonly ObservationStation[];
  startDate: string;
  endDate: string;
  now: Date;
  store: PerformanceStore;
  buildComparisons?: (input: {
    station: ObservationStation;
    startDate: string;
    endDate: string;
    now: Date;
  }) => Promise<SeedComparison[]>;
  concurrency?: number;
  onProgress?: (stationId: string, stored: number) => void;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/** Rebuild and store seed evidence for every station in the range. */
export async function runSeedBackfill(request: BackfillRequest): Promise<BackfillResult> {
  const windows = chunkMonths(request.startDate, request.endDate);
  if (windows.length === 0) throw new RangeError("backfill range is empty");
  for (const [from, to] of windows) {
    const days = Math.round(
      (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
    ) + 1;
    if (days > MAX_SEED_RANGE_DAYS) throw new RangeError("backfill window exceeds the range bound");
  }

  await request.store.initialize();
  const build = request.buildComparisons ?? buildSeedComparisons;
  const result: BackfillResult = {
    stationCount: request.stations.length,
    windowCount: windows.length,
    comparisonsBuilt: 0,
    comparisonsStored: 0,
    failures: [],
  };

  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < request.stations.length) {
      const station = request.stations[nextIndex++];
      let stored = 0;
      for (const [from, to] of windows) {
        try {
          const comparisons = await build({
            station,
            startDate: from,
            endDate: to,
            now: request.now,
          });
          result.comparisonsBuilt += comparisons.length;
          if (comparisons.length === 0) continue;
          stored += await request.store.saveSeedComparisons(comparisons);
        } catch (error) {
          result.failures.push({
            stationId: station.id,
            window: `${from}..${to}`,
            message: failureMessage(error),
          });
        }
      }
      result.comparisonsStored += stored;
      request.onProgress?.(station.id, stored);
    }
  };

  const concurrency = Math.max(
    1,
    Math.min(request.concurrency ?? 3, request.stations.length || 1),
  );
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return result;
}
