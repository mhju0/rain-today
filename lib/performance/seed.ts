import { classifyKmaResponse } from "../providers/kma.ts";
import { readResponseBytes } from "../httpResponse.ts";
import type {
  ObservationStation,
  PrecipObservation,
  PrecipProviderId,
  SeedComparison,
  SeedProviderForecast,
} from "./types.ts";

/**
 * Retrospective seed evidence — what each forecast provider's underlying model
 * predicted a DAY AHEAD for a past date, joined to the official ASOS observation
 * for that date. This exists so a first-time visitor at a station with no live
 * capture history still gets a real answer instead of equal weights.
 *
 * Three properties keep this honest, and each is load-bearing:
 *
 * 1. Day-ahead only. Open-Meteo's ordinary archive returns the day-OF run, which
 *    is effectively a nowcast; scoring it would flatter every provider and distort
 *    their ranking. The Previous Runs API's `_previous_day1` variables are the
 *    forecast issued the day before, which is what this app actually promises.
 * 2. Amount only. The archives publish no probability of precipitation, so a Seed
 *    Comparison carries none. Seed evidence is scored on amount and rain/no-rain;
 *    it never enters the probability-Brier path or the prospective benchmark.
 * 3. Model proxies are named, not implied. A provider is seeded from the model that
 *    actually drives it. A provider with no honest archive proxy is omitted here and
 *    enters at equal weight once live capture starts.
 */

const PREVIOUS_RUNS_URL = "https://previous-runs-api.open-meteo.com/v1/forecast";
const ASOS_DAILY_URL =
  "https://apis.data.go.kr/1360000/AsosDalyInfoService/getWthrDataList";
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_ASOS_RANGE_BYTES = 1024 * 1024;
/** ASOS daily rows are one per day; a request never spans more than this. */
export const MAX_SEED_RANGE_DAYS = 366;
const HOURLY_VARIABLE = "precipitation_previous_day1";

/**
 * The model behind each provider, for seeding only. `weather-api` is absent on
 * purpose: it publishes no model lineage with a public forecast archive, and a
 * guessed proxy would be a fabricated measurement of a real product.
 */
export const SEED_PROVIDER_MODELS: Readonly<Partial<Record<PrecipProviderId, string>>> = {
  "open-meteo": "best_match",
  "met-norway": "ecmwf_ifs025",
  kma: "kma_seamless",
  "pirate-weather": "gfs_seamless",
};

export const SEED_PROVIDERS: readonly PrecipProviderId[] = Object.keys(
  SEED_PROVIDER_MODELS,
) as PrecipProviderId[];

interface ArchiveRange {
  latitude: number;
  longitude: number;
  startDate: string;
  endDate: string;
}

function serviceKey(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  return value.includes("%") ? decodeURIComponent(value) : value;
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

function spanDays(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  return Math.round((end - start) / 86_400_000) + 1;
}

/** Reject a range before it reaches a provider, so one bad input cannot fan out. */
export function assertSeedRange(startDate: string, endDate: string): void {
  if (!isDate(startDate) || !isDate(endDate)) throw new RangeError("invalid seed range date");
  const days = spanDays(startDate, endDate);
  if (days <= 0) throw new RangeError("seed range ends before it starts");
  if (days > MAX_SEED_RANGE_DAYS) throw new RangeError("seed range exceeds the per-request bound");
}

interface PreviousRunsPayload {
  error?: boolean;
  reason?: string;
  hourly?: Record<string, unknown>;
}

/**
 * Sum an Asia/Seoul hourly series into daily totals. A day whose every hour is
 * null has no archived run and yields null — distinct from a forecast of 0 mm.
 */
export function sumHourlyByDate(
  times: readonly string[],
  values: readonly (number | null)[],
): Map<string, number | null> {
  const totals = new Map<string, { sum: number; present: boolean }>();
  for (const [index, time] of times.entries()) {
    const date = time.slice(0, 10);
    const entry = totals.get(date) ?? { sum: 0, present: false };
    const value = values[index];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      entry.sum += value;
      entry.present = true;
    }
    totals.set(date, entry);
  }
  return new Map(
    Array.from(totals, ([date, entry]) => [
      date,
      entry.present ? Math.round(entry.sum * 100) / 100 : null,
    ]),
  );
}

/** Reshape one Previous Runs payload into per-date provider forecasts. */
export function parseArchivedDayAheadForecasts(
  payload: unknown,
): Map<string, SeedProviderForecast[]> {
  const hourly = (payload as PreviousRunsPayload | null)?.hourly;
  if (!hourly || typeof hourly !== "object") return new Map();
  const times = hourly.time;
  if (!Array.isArray(times)) return new Map();

  const byDate = new Map<string, SeedProviderForecast[]>();
  for (const provider of SEED_PROVIDERS) {
    const model = SEED_PROVIDER_MODELS[provider]!;
    const series = hourly[`${HOURLY_VARIABLE}_${model}`];
    if (!Array.isArray(series)) continue;
    for (const [date, amountMm] of sumHourlyByDate(times as string[], series)) {
      byDate.set(date, [...(byDate.get(date) ?? []), { provider, amountMm }]);
    }
  }
  return byDate;
}

/**
 * Fetch archived day-ahead precipitation for one coordinate and date range.
 * Keyless. One call covers the whole range for every seeded model.
 */
export async function fetchArchivedDayAheadForecasts(
  range: ArchiveRange,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, SeedProviderForecast[]>> {
  assertSeedRange(range.startDate, range.endDate);
  const params = new URLSearchParams({
    latitude: String(range.latitude),
    longitude: String(range.longitude),
    start_date: range.startDate,
    end_date: range.endDate,
    hourly: HOURLY_VARIABLE,
    models: SEED_PROVIDERS.map((provider) => SEED_PROVIDER_MODELS[provider]!).join(","),
    timezone: "Asia/Seoul",
  });
  const response = await fetchImpl(`${PREVIOUS_RUNS_URL}?${params}`, {
    signal: AbortSignal.timeout(60_000),
  });
  const bytes = await readResponseBytes(response, { maxBytes: MAX_ARCHIVE_BYTES });
  const payload = JSON.parse(new TextDecoder().decode(bytes)) as PreviousRunsPayload;
  if (!response.ok || payload.error) {
    throw new Error(`archived forecast request failed (HTTP ${response.status})`);
  }
  return parseArchivedDayAheadForecasts(payload);
}

interface AsosDailyRangeItem {
  tm?: string;
  sumRn?: string;
}

/** Parse an ASOS daily RANGE response into observed millimetres keyed by date. */
export function parseAsosDailyRange(raw: unknown): Map<string, number> {
  const item = (raw as {
    response?: { body?: { items?: { item?: unknown } } };
  } | null)?.response?.body?.items?.item;
  const rows: AsosDailyRangeItem[] = Array.isArray(item)
    ? (item as AsosDailyRangeItem[])
    : item && typeof item === "object"
      ? [item as AsosDailyRangeItem]
      : [];

  const observed = new Map<string, number>();
  for (const row of rows) {
    const date = (row.tm ?? "").trim();
    if (!isDate(date)) continue;
    // ASOS leaves 일강수량 blank on a dry day; a present row with a blank total is
    // a measured zero, not missing data.
    const value = (row.sumRn ?? "").trim();
    const observedMm = value === "" ? 0 : Number(value);
    if (!Number.isFinite(observedMm) || observedMm < 0) continue;
    observed.set(date, observedMm);
  }
  return observed;
}

/**
 * Fetch observed daily precipitation for one station across a date range. The
 * ASOS daily service accepts a range, so a month of ground truth costs one call.
 * Returns an empty map rather than throwing when the service is unusable, so a
 * backfill skips that window instead of fabricating it.
 */
export async function fetchAsosObservationRange(
  stationId: string,
  startDate: string,
  endDate: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, number>> {
  assertSeedRange(startDate, endDate);
  const key = serviceKey(
    process.env.KMA_OBSERVATION_API_KEY ?? process.env.KMA_SHORT_TERM_API_KEY,
  );
  if (!key) return new Map();
  const params = new URLSearchParams({
    serviceKey: key,
    dataType: "JSON",
    dataCd: "ASOS",
    dateCd: "DAY",
    startDt: startDate.replace(/-/g, ""),
    endDt: endDate.replace(/-/g, ""),
    stnIds: stationId,
    numOfRows: String(MAX_SEED_RANGE_DAYS + 1),
    pageNo: "1",
  });

  let response: Response;
  try {
    response = await fetchImpl(`${ASOS_DAILY_URL}?${params}`, {
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return new Map();
  }
  const bytes = await readResponseBytes(response, { maxBytes: MAX_ASOS_RANGE_BYTES });
  const text = new TextDecoder().decode(bytes);
  const classified = classifyKmaResponse(response.status, text);
  if (classified.class !== "ok") return new Map();
  return parseAsosDailyRange(classified.json);
}

/** Join archived forecasts to observations for one station. Unpaired dates drop. */
export function joinSeedComparisons(
  stationId: string,
  forecasts: ReadonlyMap<string, SeedProviderForecast[]>,
  observations: ReadonlyMap<string, number>,
  builtAt: Date,
): SeedComparison[] {
  const comparisons: SeedComparison[] = [];
  for (const [targetDate, observedMm] of observations) {
    const providers = (forecasts.get(targetDate) ?? []).filter(
      (forecast) => forecast.amountMm !== null,
    );
    if (providers.length === 0) continue;
    comparisons.push({
      stationId,
      targetDate,
      providers,
      observedMm,
      builtAt: builtAt.toISOString(),
    });
  }
  return comparisons.sort((a, b) => a.targetDate.localeCompare(b.targetDate));
}

export interface SeedComparisonRequest {
  station: ObservationStation;
  startDate: string;
  endDate: string;
  now: Date;
  fetchArchive?: typeof fetchArchivedDayAheadForecasts;
  fetchObservations?: typeof fetchAsosObservationRange;
}

/** Build every Seed Comparison available for one station and date range. */
export async function buildSeedComparisons(
  request: SeedComparisonRequest,
): Promise<SeedComparison[]> {
  assertSeedRange(request.startDate, request.endDate);
  const observations = await (request.fetchObservations ?? fetchAsosObservationRange)(
    request.station.id,
    request.startDate,
    request.endDate,
  );
  if (observations.size === 0) return [];
  const forecasts = await (request.fetchArchive ?? fetchArchivedDayAheadForecasts)({
    latitude: request.station.latitude,
    longitude: request.station.longitude,
    startDate: request.startDate,
    endDate: request.endDate,
  });
  return joinSeedComparisons(request.station.id, forecasts, observations, request.now);
}

/** Adapt a Seed Comparison's observation to the shared observation record. */
export function seedObservation(comparison: SeedComparison): PrecipObservation {
  return {
    stationId: comparison.stationId,
    date: comparison.targetDate,
    observedMm: comparison.observedMm,
    observedAt: comparison.builtAt,
    source: "kma-asos",
  };
}
