import { classifyKmaResponse } from "../providers/kma.ts";
import type { ObservationStation, PrecipObservation } from "./types.ts";

const STATION_CATALOG_URL = "https://apihub.kma.go.kr/api/typ01/url/stn_inf.php";
const ASOS_DAILY_URL =
  "https://apis.data.go.kr/1360000/AsosDalyInfoService/getWthrDataList";

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
  const response = await fetchImpl(`${STATION_CATALOG_URL}?${params}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`KMA station catalog returned HTTP ${response.status}`);
  const stations = parseKmaStationCatalog(await response.text(), at);
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
  const text = await response.text();
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
