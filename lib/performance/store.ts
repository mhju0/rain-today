import type {
  CaptureCohort,
  ForecastCapture,
  ObservationStation,
  PrecipObservation,
} from "./types.ts";

export type CaptureWriteResult = "inserted" | "existing";

/** Durable boundary for prospective forecast evidence. User coordinates never cross it. */
export interface PerformanceStore {
  initialize(): Promise<void>;
  upsertStations(stations: readonly ObservationStation[]): Promise<void>;
  listStations(): Promise<ObservationStation[]>;
  saveCapture(capture: ForecastCapture): Promise<CaptureWriteResult>;
  saveObservation(observation: PrecipObservation): Promise<void>;
  loadCaptures(stationId: string, cohort: CaptureCohort): Promise<ForecastCapture[]>;
  loadObservations(stationId: string): Promise<PrecipObservation[]>;
  close(): Promise<void>;
}

const clone = <T>(value: T): T => structuredClone(value);

/** Deterministic adapter for tests and local orchestration; production uses PostgreSQL. */
export class InMemoryPerformanceStore implements PerformanceStore {
  readonly #stations = new Map<string, ObservationStation>();
  readonly #captures = new Map<string, ForecastCapture>();
  readonly #observations = new Map<string, PrecipObservation>();

  async initialize(): Promise<void> {}

  async upsertStations(stations: readonly ObservationStation[]): Promise<void> {
    for (const station of stations) this.#stations.set(station.id, clone(station));
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

  async close(): Promise<void> {}
}
