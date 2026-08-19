import { classifyKmaResponse } from "../providers/kma.ts";
import { readResponseBytes } from "../httpResponse.ts";
import type { ObservationStation, PrecipObservation } from "./types.ts";

const STATION_CATALOG_URL = "https://apihub.kma.go.kr/api/typ01/url/stn_inf.php";
const ASOS_DAILY_URL =
  "https://apis.data.go.kr/1360000/AsosDalyInfoService/getWthrDataList";
const MAX_STATION_CATALOG_BYTES = 1024 * 1024;
const STATION_CATALOG_ATTEMPTS = 3;
const MAX_ASOS_OBSERVATION_BYTES = 256 * 1024;

function koreanDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function koreanTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}${value("month")}${value("day")}${value("hour")}${value("minute")}`;
}

function serviceKey(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  return value.includes("%") ? decodeURIComponent(value) : value;
}

/** Parse KMA's whitespace-delimited current surface-station catalog. */
export function parseKmaStationCatalog(body: string, at: Date): ObservationStation[] {
  const activeFrom = koreanDate(at);
  return body.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return [];
    const columns = trimmed.split(/\s+/);
    if (columns.length < 11) return [];
    const id = columns[0];
    const longitude = Number(columns[1]);
    const latitude = Number(columns[2]);
    const elevation = Number(columns[4]);
    const name = columns[10];
    if (
      !/^\d+$/.test(id) ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      !name ||
      latitude < 32 ||
      latitude > 39.5 ||
      longitude < 124 ||
      longitude > 132
    ) {
      return [];
    }
    return [{
      id,
      name,
      network: "ASOS" as const,
      latitude,
      longitude,
      elevationM: Number.isFinite(elevation) && elevation >= 0 ? elevation : null,
      activeFrom,
      activeTo: null,
    }];
  });
}

/**
 * The catalog is the one call the cohort cannot continue without: it runs before any
 * station is read, so a single dropped connection used to discard the whole run.
 * Scheduled runners reach apihub only intermittently, so retry a thrown transport
 * error — a connect failure or a timeout. A refusal is the server's actual answer and
 * is never retried.
 */
async function fetchCatalog(url: string, fetchImpl: typeof fetch): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < STATION_CATALOG_ATTEMPTS; attempt += 1) {
    try {
      return await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * apihub serves the typ01 catalog as EUC-KR, not UTF-8. Decoding it as UTF-8 turns
 * every Korean station name into replacement characters, and those names are shown
 * to the reader, so honour the declared charset and fall back to EUC-KR.
 */
function decodeCatalog(response: Response, bytes: Uint8Array): string {
  const declared = /charset=([\w-]+)/i.exec(response.headers.get("content-type") ?? "")?.[1];
  try {
    return new TextDecoder(declared ?? "euc-kr").decode(bytes);
  } catch {
    return new TextDecoder("euc-kr").decode(bytes);
  }
}

export async function fetchKmaAsosStations(
  at: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<ObservationStation[]> {
  const key = serviceKey(process.env.KMA_APIHUB_KEY);
  if (!key) throw new Error("KMA_APIHUB_KEY is required for the ASOS station catalog");
  const params = new URLSearchParams({
    inf: "SFC",
    stn: "0",
    tm: koreanTimestamp(at),
    help: "0",
    authKey: key,
  });
  const response = await fetchCatalog(`${STATION_CATALOG_URL}?${params}`, fetchImpl);
  if (!response.ok) throw new Error(`KMA station catalog returned HTTP ${response.status}`);
  const catalog = await readResponseBytes(response, { maxBytes: MAX_STATION_CATALOG_BYTES });
  const stations = parseKmaStationCatalog(decodeCatalog(response, catalog), at);
  if (stations.length === 0) throw new Error("KMA station catalog contained no usable ASOS rows");
  return stations;
}

interface AsosDailyItem {
  sumRn?: string;
}

export function parseAsosDailyObservation(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const response = (raw as { response?: unknown }).response;
  if (!response || typeof response !== "object") return null;
  const body = (response as { body?: unknown }).body;
  if (!body || typeof body !== "object") return null;
  const items = (body as { items?: unknown }).items;
  if (!items || typeof items !== "object") return null;
  const item = (items as { item?: unknown }).item;
  const row = (Array.isArray(item) ? item[0] : item) as AsosDailyItem | null | undefined;
  if (!row || typeof row !== "object") return null;
  const value = (row.sumRn ?? "").trim();
  const observedMm = value === "" ? 0 : Number(value);
  return Number.isFinite(observedMm) && observedMm >= 0 ? observedMm : null;
}

export async function fetchAsosObservation(
  stationId: string,
  date: string,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<PrecipObservation | null> {
  const key = serviceKey(
    process.env.KMA_OBSERVATION_API_KEY ?? process.env.KMA_SHORT_TERM_API_KEY,
  );
  if (!key) return null;
  const compactDate = date.replace(/-/g, "");
  const params = new URLSearchParams({
    serviceKey: key,
    dataType: "JSON",
    dataCd: "ASOS",
    dateCd: "DAY",
    startDt: compactDate,
    endDt: compactDate,
    stnIds: stationId,
    numOfRows: "10",
    pageNo: "1",
  });
  let response: Response;
  try {
    response = await fetchImpl(`${ASOS_DAILY_URL}?${params}`, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return null;
  }
  const bytes = await readResponseBytes(response, { maxBytes: MAX_ASOS_OBSERVATION_BYTES });
  const text = new TextDecoder().decode(bytes);
  const classified = classifyKmaResponse(response.status, text);
  if (classified.class !== "ok") return null;
  const observedMm = parseAsosDailyObservation(classified.json);
  if (observedMm === null) return null;
  return {
    stationId,
    date,
    observedMm,
    observedAt: now.toISOString(),
    source: "kma-asos",
  };
}
