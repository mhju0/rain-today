import type {
  CaptureCohort,
  CompletedComparison,
  ForecastCapture,
  ObservationStation,
  PrecipObservation,
} from "./types.ts";

export type CaptureWriteResult = "inserted" | "existing";

const CATALOG_DROP_GUARD_MIN_ACTIVE_STATIONS = 20;
const CATALOG_DROP_GUARD_MIN_RETAINED_RATIO = 0.8;

export function assertSafeStationCatalogSync(
  currentActiveIds: ReadonlySet<string>,
  stations: readonly ObservationStation[],
): void {
  if (currentActiveIds.size < CATALOG_DROP_GUARD_MIN_ACTIVE_STATIONS) return;
  const nextActiveIds = new Set(stations.map((station) => station.id));
  const retained = Array.from(currentActiveIds).filter((id) => nextActiveIds.has(id)).length;
  if (retained / currentActiveIds.size < CATALOG_DROP_GUARD_MIN_RETAINED_RATIO) {
    throw new Error("station catalog drop exceeds the retirement safety threshold");
  }
}

/** Durable boundary for prospective forecast evidence. User coordinates never cross it. */
export interface PerformanceStore {
  initialize(): Promise<void>;
  syncStations(stations: readonly ObservationStation[], catalogDate: string): Promise<void>;
  listStations(): Promise<ObservationStation[]>;
  saveCapture(capture: ForecastCapture): Promise<CaptureWriteResult>;
  saveObservation(observation: PrecipObservation): Promise<void>;
  loadCompletedComparisons(
    stationId: string,
    cohort: CaptureCohort,
    limit: number,
  ): Promise<CompletedComparison[]>;
  close(): Promise<void>;
}

const clone = <T>(value: T): T => structuredClone(value);

/** Deterministic adapter for tests and local orchestration; production uses PostgreSQL. */
export class InMemoryPerformanceStore implements PerformanceStore {
  readonly #stations = new Map<string, ObservationStation>();
  readonly #captures = new Map<string, ForecastCapture>();
  readonly #observations = new Map<string, PrecipObservation>();

  async initialize(): Promise<void> {}

  async syncStations(
    stations: readonly ObservationStation[],
    catalogDate: string,
  ): Promise<void> {
    if (stations.length === 0) return;
    const activeIds = new Set(stations.map((station) => station.id));
    assertSafeStationCatalogSync(
      new Set(
        Array.from(this.#stations.values())
          .filter((station) => station.activeTo === null)
          .map((station) => station.id),
      ),
      stations,
    );
    const previousDate = new Date(Date.parse(`${catalogDate}T00:00:00.000Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    for (const [id, existing] of this.#stations) {
      if (existing.activeTo === null && !activeIds.has(id)) {
        this.#stations.set(id, { ...existing, activeTo: previousDate });
      }
    }
    for (const station of stations) {
      const existing = this.#stations.get(station.id);
      this.#stations.set(station.id, clone({
        ...station,
        activeFrom: existing?.activeFrom ?? station.activeFrom,
        activeTo: null,
      }));
    }
  }

  async listStations(): Promise<ObservationStation[]> {
    return Array.from(this.#stations.values())
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map(clone);
  }

  async saveCapture(capture: ForecastCapture): Promise<CaptureWriteResult> {
    const key = `${capture.stationId}:${capture.targetDate}:${capture.cohort}`;
    if (this.#captures.has(key)) return "existing";
    this.#captures.set(key, clone(capture));
    return "inserted";
  }

  async saveObservation(observation: PrecipObservation): Promise<void> {
    this.#observations.set(`${observation.stationId}:${observation.date}`, clone(observation));
  }

  async loadCaptures(stationId: string, cohort: CaptureCohort): Promise<ForecastCapture[]> {
    return Array.from(this.#captures.values())
      .filter((capture) => capture.stationId === stationId && capture.cohort === cohort)
      .sort((a, b) => a.targetDate.localeCompare(b.targetDate))
      .map(clone);
  }

  async loadObservations(stationId: string): Promise<PrecipObservation[]> {
    return Array.from(this.#observations.values())
      .filter((observation) => observation.stationId === stationId)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(clone);
  }

  async loadCompletedComparisons(
    stationId: string,
    cohort: CaptureCohort,
    limit: number,
  ): Promise<CompletedComparison[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("invalid comparison limit");
    const observations = new Map(
      Array.from(this.#observations.values())
        .filter((observation) => observation.stationId === stationId)
        .map((observation) => [observation.date, observation]),
    );
    return Array.from(this.#captures.values())
      .filter((capture) => capture.stationId === stationId && capture.cohort === cohort)
      .flatMap((capture) => {
        const observation = observations.get(capture.targetDate);
        return observation ? [{ capture, observation }] : [];
      })
      .sort((a, b) => a.capture.targetDate.localeCompare(b.capture.targetDate))
      .slice(-limit)
      .map(clone);
  }

  async close(): Promise<void> {}
}
