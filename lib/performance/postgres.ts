import postgres from "postgres";
import type {
  CaptureCohort,
  CompletedComparison,
  ForecastCapture,
  ObservationStation,
  PrecipObservation,
} from "./types.ts";
import {
  assertSafeStationCatalogSync,
  type CaptureWriteResult,
  type PerformanceStore,
} from "./store.ts";

interface CompletedComparisonRow {
  station_id: string;
  target_date: string;
  cohort: CaptureCohort;
  captured_at: string;
  providers: ForecastCapture["providers"];
  frozen_blend: ForecastCapture["frozenBlend"];
  observation_date: string;
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

interface StationIdRow {
  id: string;
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
        network text not null check (network = 'ASOS'),
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
        source text not null check (source = 'kma-asos'),
        primary key (station_id, date)
      )
    `;
    await this.#sql`
      create index if not exists performance_captures_station_cohort_date
      on performance_captures (station_id, cohort, target_date)
    `;
    await this.#sql`
      create index if not exists performance_captures_providers
      on performance_captures using gin (providers jsonb_path_ops)
    `;
    await this.#sql`
      create index if not exists performance_observations_station_date
      on performance_observations (station_id, date)
    `;
  }

  async syncStations(
    stations: readonly ObservationStation[],
    catalogDate: string,
  ): Promise<void> {
    if (stations.length === 0) return;
    await this.#sql.begin(async (sql) => {
      const currentRows = await sql<StationIdRow[]>`
        select id
        from performance_stations
        where network = 'ASOS' and active_to is null
      `;
      assertSafeStationCatalogSync(new Set(currentRows.map((row) => row.id)), stations);
      const activeIds = new Set(stations.map((station) => station.id));
      for (const row of currentRows) {
        if (activeIds.has(row.id)) continue;
        await sql`
          update performance_stations
          set active_to = ${catalogDate}::date - 1
          where id = ${row.id} and active_to is null
        `;
      }
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
            active_to = null
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

  async loadCompletedComparisons(
    stationId: string,
    cohort: CaptureCohort,
    limit: number,
  ): Promise<CompletedComparison[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("invalid comparison limit");
    const rows = await this.#sql<CompletedComparisonRow[]>`
      with provider_ids (provider) as (
        values
          (${"open-meteo"}::text),
          (${"met-norway"}::text),
          (${"kma"}::text),
          (${"pirate-weather"}::text),
          (${"weather-api"}::text)
      ),
      recent_dates as (
        select distinct recent.target_date
        from provider_ids
        cross join lateral (
          select capture.target_date
          from performance_captures as capture
          join performance_observations as observation
            on observation.station_id = capture.station_id
            and observation.date = capture.target_date
          where capture.station_id = ${stationId}
            and capture.cohort = ${cohort}
            and capture.providers @> jsonb_build_array(
              jsonb_build_object('provider', provider_ids.provider)
            )
            and exists (
              select 1
              from jsonb_array_elements(capture.providers) as forecast(value)
              where forecast.value ->> 'provider' = provider_ids.provider
                and case
                  when jsonb_typeof(forecast.value -> 'probability') = 'number'
                  then (forecast.value ->> 'probability')::double precision between 0 and 100
                  else false
                end
            )
          order by capture.target_date desc
          limit ${limit}
        ) as recent
      )
      select
        capture.station_id,
        capture.target_date::text,
        capture.cohort,
        capture.captured_at::text,
        capture.providers,
        capture.frozen_blend,
        observation.date::text as observation_date,
        observation.observed_mm,
        observation.observed_at::text,
        observation.source
      from performance_captures as capture
      join performance_observations as observation
        on observation.station_id = capture.station_id
        and observation.date = capture.target_date
      join recent_dates on recent_dates.target_date = capture.target_date
      where capture.station_id = ${stationId} and capture.cohort = ${cohort}
      order by capture.target_date
    `;
    return rows.map((row) => ({
      capture: {
        stationId: row.station_id,
        targetDate: row.target_date,
        cohort: row.cohort,
        capturedAt: isoTimestamp(row.captured_at),
        providers: row.providers,
        frozenBlend: row.frozen_blend,
      },
      observation: {
        stationId: row.station_id,
        date: row.observation_date,
        observedMm: row.observed_mm,
        observedAt: isoTimestamp(row.observed_at),
        source: row.source,
      },
    }));
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }
}
