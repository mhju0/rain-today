import { readResponseBytes } from "./httpResponse.ts";
import { createForecastLocation } from "./location.ts";

const KAKAO_ADDRESS_URL = "https://dapi.kakao.com/v2/local/search/address.json";
const KAKAO_REGION_URL = "https://dapi.kakao.com/v2/local/geo/coord2regioncode.json";

/**
 * Search is unavailable because no Kakao credential is configured, which no
 * amount of retrying fixes. Distinct from a transient upstream failure so the
 * route can stop offering the user a retry that can never succeed.
 */
export class LocationSearchNotConfiguredError extends Error {
  constructor() {
    super("Kakao location search is not configured");
    this.name = "LocationSearchNotConfiguredError";
  }
}

const SIDO_LABELS: Readonly<Record<string, string>> = {
  서울: "서울특별시",
  부산: "부산광역시",
  대구: "대구광역시",
  인천: "인천광역시",
  광주: "전남광주통합특별시",
  전남광주: "전남광주통합특별시",
  대전: "대전광역시",
  울산: "울산광역시",
  세종: "세종특별자치시",
  제주: "제주특별자치도",
} as const;

const KOREAN_CITY_ALIASES: Readonly<Record<string, string>> = {
  서울: SIDO_LABELS.서울,
  서울시: SIDO_LABELS.서울,
  부산: SIDO_LABELS.부산,
  부산시: SIDO_LABELS.부산,
  대구: SIDO_LABELS.대구,
  대구시: SIDO_LABELS.대구,
  인천: SIDO_LABELS.인천,
  인천시: SIDO_LABELS.인천,
  광주: SIDO_LABELS.광주,
  광주시: SIDO_LABELS.광주,
  대전: SIDO_LABELS.대전,
  대전시: SIDO_LABELS.대전,
  울산: SIDO_LABELS.울산,
  울산시: SIDO_LABELS.울산,
  세종: SIDO_LABELS.세종,
  세종시: SIDO_LABELS.세종,
} as const;

export interface ForecastLocationSearchResult {
  id: string;
  name: string;
  label: string;
  latitude: number;
  longitude: number;
  elevationM: number | null;
  kind: "administrative-area" | "legal-area";
  /**
   * The 법정동 name for the same point, when it differs from the 행정동 one.
   * Both used to be offered as separate rows carrying identical coordinates, so
   * the user chose between options that produce the same forecast.
   */
  alternateName?: string;
  administrativeCode?: string;
  legalCode?: string;
  source: "kakao";
}

interface KakaoAddress {
  region_1depth_name?: string;
  region_2depth_name?: string;
  region_3depth_name?: string;
  region_3depth_h_name?: string;
  h_code?: string;
  b_code?: string;
  x?: string;
  y?: string;
}

interface KakaoAddressDocument {
  address_type?: string;
  x?: string;
  y?: string;
  address?: KakaoAddress | null;
}

interface KakaoAddressResponse {
  documents?: unknown;
}

export interface LocationSearchOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

function documentsFrom(raw: unknown): KakaoAddressDocument[] {
  if (!raw || typeof raw !== "object") return [];
  const documents = (raw as KakaoAddressResponse).documents;
  return Array.isArray(documents) ? documents as KakaoAddressDocument[] : [];
}

function canonicalSido(name: string | undefined): string {
  if (!name) return "";
  return SIDO_LABELS[name] ?? name;
}

function optionalCode(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toResults(document: KakaoAddressDocument): ForecastLocationSearchResult[] {
  if (document.address_type !== "REGION") return [];
  const address = document.address;
  if (!address || typeof address !== "object") return [];
  const latitude = Number(address.y ?? document.y);
  const longitude = Number(address.x ?? document.x);
  const administrativeCode = optionalCode(address.h_code);
  const legalCode = optionalCode(address.b_code);
  if (!administrativeCode && !legalCode) return [];

  const sido = canonicalSido(address.region_1depth_name);
  const district = address.region_2depth_name?.trim() ?? "";
  const legalNeighborhood = address.region_3depth_name?.trim() ?? "";
  const administrativeNeighborhood = address.region_3depth_h_name?.trim() || legalNeighborhood;

  const buildResult = (
    kind: ForecastLocationSearchResult["kind"],
    code: string,
    neighborhood: string,
  ): ForecastLocationSearchResult | null => {
    const name = neighborhood || district || sido;
    if (!name) return null;
    try {
      const location = createForecastLocation({ name, latitude, longitude });
      return {
        id: `kakao:${kind === "administrative-area" ? "h" : "b"}:${code}`,
        name: location.name,
        label: Array.from(new Set([sido, district, neighborhood].filter(Boolean))).join(" "),
        latitude: location.latitude,
        longitude: location.longitude,
        elevationM: null,
        kind,
        ...(administrativeCode ? { administrativeCode } : {}),
        ...(legalCode ? { legalCode } : {}),
        source: "kakao",
      };
    } catch {
      return null;
    }
  };

  const results: ForecastLocationSearchResult[] = [];
  const administrative = administrativeCode
    ? buildResult("administrative-area", administrativeCode, administrativeNeighborhood)
    : null;
  if (administrative) {
    // One row per place. The 행정동 is the name a resident uses, so it leads and
    // carries the 법정동 name alongside rather than spawning a twin row.
    if (legalNeighborhood && legalNeighborhood !== administrativeNeighborhood) {
      administrative.alternateName = legalNeighborhood;
    }
    results.push(administrative);
  } else if (legalCode) {
    const legal = buildResult("legal-area", legalCode, legalNeighborhood);
    if (legal) results.push(legal);
  }
  return results;
}

async function fetchKakaoDocuments(
  query: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<KakaoAddressDocument[]> {
  const params = new URLSearchParams({
    query,
    analyze_type: "similar",
    page: "1",
    size: "10",
  });
  const response = await fetchImpl(`${KAKAO_ADDRESS_URL}?${params}`, {
    headers: {
      Accept: "application/json",
      Authorization: `KakaoAK ${apiKey}`,
    },
    signal,
  });
  if (!response.ok) throw new Error(`location search returned HTTP ${response.status}`);
  const bytes = await readResponseBytes(response, {
    maxBytes: 256 * 1024,
    contentType: "application/json",
  });
  return documentsFrom(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
}

/**
 * Every full-hierarchy name this row answers to. A collapsed row stands for both
 * the 행정동 and the 법정동 at one point, so a user who types either exact path
 * must still rank it first.
 */
function matchLabels(result: ForecastLocationSearchResult): string[] {
  if (!result.alternateName) return [result.label];
  const segments = result.label.split(" ");
  return [result.label, [...segments.slice(0, -1), result.alternateName].join(" ")];
}

function rankResults(
  results: ForecastLocationSearchResult[],
  normalizedQuery: string,
): ForecastLocationSearchResult[] {
  if (!normalizedQuery.includes(" ")) return results;
  const segments = normalizedQuery.split(" ");
  const canonicalQuery = [KOREAN_CITY_ALIASES[segments[0]] ?? segments[0], ...segments.slice(1)]
    .join(" ");
  return results
    .map((result, index) => ({ result, index }))
    .sort((a, b) => {
      const aExact = matchLabels(a.result).includes(canonicalQuery) ? 0 : 1;
      const bExact = matchLabels(b.result).includes(canonicalQuery) ? 0 : 1;
      return aExact - bExact || a.index - b.index;
    })
    .map(({ result }) => result);
}

/** Search Korean administrative places without retaining the query or selected coordinates. */
export async function searchKoreanLocations(
  query: string,
  options: LocationSearchOptions = {},
): Promise<ForecastLocationSearchResult[]> {
  const normalized = query.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (normalized.length < 2) throw new RangeError("location query must contain two characters");
  if (normalized.length > 80) throw new RangeError("location query is too long");
  const apiKey = options.apiKey?.trim() || process.env.KAKAO_REST_API_KEY?.trim();
  if (!apiKey) throw new LocationSearchNotConfiguredError();

  const upstreamQuery = KOREAN_CITY_ALIASES[normalized] ?? normalized;
  const queries = [upstreamQuery];
  if (upstreamQuery === normalized && !/[도시군구읍면동]$/.test(normalized)) {
    queries.push(`${normalized}동`);
  }

  const signal = AbortSignal.timeout(8_000);
  for (const searchQuery of queries) {
    const unique = new Map<string, ForecastLocationSearchResult>();
    for (const document of await fetchKakaoDocuments(
      searchQuery,
      apiKey,
      options.fetchImpl ?? fetch,
      signal,
    )) {
      for (const result of toResults(document)) {
        if (!unique.has(result.id)) unique.set(result.id, result);
      }
    }
    if (unique.size > 0) return rankResults([...unique.values()], normalized);
  }
  return [];
}

interface KakaoRegionDocument {
  region_type?: string;
  region_1depth_name?: string;
  region_2depth_name?: string;
  region_3depth_name?: string;
}

/**
 * Resolve a device coordinate to its 시·구·동 name.
 *
 * Enrichment only: every failure path returns null so the forecast still
 * renders under the caller's placeholder. Without this, a geolocation user sees
 * "현재 위치" as the only label on the page and has no way to tell whether the
 * fix landed on their neighbourhood or the next city.
 */
export async function describeKoreanCoordinate(
  latitude: number,
  longitude: number,
  options: LocationSearchOptions = {},
): Promise<string | null> {
  const apiKey = options.apiKey?.trim() || process.env.KAKAO_REST_API_KEY?.trim();
  if (!apiKey) return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const params = new URLSearchParams({ x: String(longitude), y: String(latitude) });
  try {
    const response = await (options.fetchImpl ?? fetch)(`${KAKAO_REGION_URL}?${params}`, {
      headers: { Accept: "application/json", Authorization: `KakaoAK ${apiKey}` },
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return null;
    const bytes = await readResponseBytes(response, {
      maxBytes: 64 * 1024,
      contentType: "application/json",
    });
    const raw = JSON.parse(new TextDecoder().decode(bytes)) as { documents?: unknown };
    const documents = Array.isArray(raw.documents)
      ? (raw.documents as KakaoRegionDocument[])
      : [];
    // "H" is the 행정동 a resident would name; "B" (법정동) is the fallback.
    const region = documents.find((entry) => entry.region_type === "H")
      ?? documents.find((entry) => entry.region_type === "B");
    if (!region) return null;

    const parts = [
      canonicalSido(region.region_1depth_name),
      region.region_2depth_name?.trim() ?? "",
      region.region_3depth_name?.trim() ?? "",
    ].filter(Boolean);
    if (parts.length === 0) return null;
    const name = Array.from(new Set(parts)).join(" ");
    return name.length <= 80 ? name : null;
  } catch {
    return null;
  }
}
