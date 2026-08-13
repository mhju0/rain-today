import postgres from "postgres";
import type {
  CaptureCohort,
  ForecastCapture,
  ObservationStation,
  PrecipObservation,
} from "./types.ts";
import type { CaptureWriteResult, PerformanceStore } from "./store.ts";

interface CaptureRow {
  station_id: string;
  target_date: string;
  cohort: CaptureCohort;
  captured_at: string;
  providers: ForecastCapture["providers"];
  frozen_blend: ForecastCapture["frozenBlend"];
}

interface ObservationRow {
  station_id: string;
  date: string;
  observed_mm: number;
  observed_at: string;
  source: PrecipObservation["source"];
}

interface StationRow {
  id: string;
  name: string;
  network: ObservationStation["network"];
  latitude: number;
  longitude: number;
  elevation_m: number | null;
  active_from: string;
  active_to: string | null;
}

function isoTimestamp(value: string): string {
  return new Date(value).toISOString();
}

export class PostgresPerformanceStore implements PerformanceStore {
  readonly #sql: ReturnType<typeof postgres>;

  constructor(connectionUrl: string) {
    if (!connectionUrl.trim()) throw new Error("PERFORMANCE_DATABASE_URL is required");
    this.#sql = postgres(connectionUrl, {
      max: 4,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }

  async initialize(): Promise<void> {
    await this.#sql`
      create table if not exists performance_stations (
        id text primary key,
        name text not null,
        network text not null check (network in ('ASOS', 'AWS')),
        latitude double precision not null,
        longitude double precision not null,
        elevation_m double precision,
        active_from date not null,
        active_to date
      )
    `;
    await this.#sql`
      create table if not exists performance_captures (
        station_id text not null references performance_stations(id),
        target_date date not null,
        cohort text not null check (cohort in ('06', '18')),
        captured_at timestamptz not null,
        providers jsonb not null,
        frozen_blend jsonb not null,
        primary key (station_id, target_date, cohort)
      )
    `;
    await this.#sql`
      create table if not exists performance_observations (
        station_id text not null references performance_stations(id),
        date date not null,
        observed_mm double precision not null check (observed_mm >= 0),
        observed_at timestamptz not null,
        source text not null check (source in ('kma-asos', 'kma-aws')),
        primary key (station_id, date)
      )
    `;
    await this.#sql`
      create index if not exists performance_captures_station_cohort_date
      on performance_captures (station_id, cohort, target_date)
    `;
    await this.#sql`
      create index if not exists performance_observations_station_date
      on performance_observations (station_id, date)
    `;
  }

  async upsertStations(stations: readonly ObservationStation[]): Promise<void> {
    if (stations.length === 0) return;
    await this.#sql.begin(async (sql) => {
      for (const station of stations) {
        await sql`
          insert into performance_stations (
            id, name, network, latitude, longitude, elevation_m, active_from, active_to
          ) values (
            ${station.id}, ${station.name}, ${station.network}, ${station.latitude},
            ${station.longitude}, ${station.elevationM}, ${station.activeFrom}, ${station.activeTo}
          )
          on conflict (id) do update set
            name = excluded.name,
            network = excluded.network,
            latitude = excluded.latitude,
            longitude = excluded.longitude,
            elevation_m = excluded.elevation_m,
            active_to = excluded.active_to
        `;
      }
    });
  }

  async listStations(): Promise<ObservationStation[]> {
    const rows = await this.#sql<StationRow[]>`
      select id, name, network, latitude, longitude, elevation_m, active_from::text, active_to::text
      from performance_stations
      order by id::integer
    `;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      network: row.network,
      latitude: row.latitude,
      longitude: row.longitude,
      elevationM: row.elevation_m,
      activeFrom: row.active_from,
      activeTo: row.active_to,
    }));
  }

  async saveCapture(capture: ForecastCapture): Promise<CaptureWriteResult> {
    const rows = await this.#sql`
      insert into performance_captures (
        station_id, target_date, cohort, captured_at, providers, frozen_blend
      ) values (
        ${capture.stationId}, ${capture.targetDate}, ${capture.cohort}, ${capture.capturedAt},
        ${this.#sql.json(capture.providers as unknown as postgres.JSONValue)},
        ${this.#sql.json(capture.frozenBlend as unknown as postgres.JSONValue)}
      )
      on conflict (station_id, target_date, cohort) do nothing
      returning station_id
    `;
    return rows.length === 0 ? "existing" : "inserted";
  }

  async saveObservation(observation: PrecipObservation): Promise<void> {
    await this.#sql`
      insert into performance_observations (
        station_id, date, observed_mm, observed_at, source
      ) values (
        ${observation.stationId}, ${observation.date}, ${observation.observedMm},
        ${observation.observedAt}, ${observation.source}
      )
      on conflict (station_id, date) do update set
        observed_mm = excluded.observed_mm,
        observed_at = excluded.observed_at,
        source = excluded.source
    `;
  }

  async loadCaptures(stationId: string, cohort: CaptureCohort): Promise<ForecastCapture[]> {
    const rows = await this.#sql<CaptureRow[]>`
      select station_id, target_date::text, cohort, captured_at::text, providers, frozen_blend
      from performance_captures
      where station_id = ${stationId} and cohort = ${cohort}
      order by target_date
    `;
    return rows.map((row) => ({
      stationId: row.station_id,
      targetDate: row.target_date,
      cohort: row.cohort,
      capturedAt: isoTimestamp(row.captured_at),
      providers: row.providers,
      frozenBlend: row.frozen_blend,
    }));
  }

  async loadObservations(stationId: string): Promise<PrecipObservation[]> {
    const rows = await this.#sql<ObservationRow[]>`
      select station_id, date::text, observed_mm, observed_at::text, source
      from performance_observations
      where station_id = ${stationId}
      order by date
    `;
    return rows.map((row) => ({
      stationId: row.station_id,
      date: row.date,
      observedMm: row.observed_mm,
      observedAt: isoTimestamp(row.observed_at),
      source: row.source,
    }));
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }
}
