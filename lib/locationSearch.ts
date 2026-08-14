import { readResponseBytes } from "./httpResponse.ts";
import { createForecastLocation } from "./location.ts";

const KAKAO_ADDRESS_URL = "https://dapi.kakao.com/v2/local/search/address.json";
const KOREAN_CITY_ALIASES: Readonly<Record<string, string>> = {
  서울: "서울특별시",
  서울시: "서울특별시",
  부산: "부산광역시",
  부산시: "부산광역시",
  대구: "대구광역시",
  대구시: "대구광역시",
  인천: "인천광역시",
  인천시: "인천광역시",
  광주: "광주광역시",
  광주시: "광주광역시",
  대전: "대전광역시",
  대전시: "대전광역시",
  울산: "울산광역시",
  울산시: "울산광역시",
  세종: "세종특별자치시",
  세종시: "세종특별자치시",
} as const;

const SIDO_LABELS: Readonly<Record<string, string>> = {
  서울: "서울특별시",
  부산: "부산광역시",
  대구: "대구광역시",
  인천: "인천광역시",
  광주: "광주광역시",
  대전: "대전광역시",
  울산: "울산광역시",
  세종: "세종특별자치시",
  제주: "제주특별자치도",
} as const;

export interface ForecastLocationSearchResult {
  id: string;
  name: string;
  label: string;
  latitude: number;
  longitude: number;
  elevationM: number | null;
  kind: "administrative-area" | "legal-area";
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

function toResult(document: KakaoAddressDocument): ForecastLocationSearchResult | null {
  if (document.address_type !== "REGION") return null;
  const address = document.address;
  if (!address || typeof address !== "object") return null;
  const latitude = Number(address.y ?? document.y);
  const longitude = Number(address.x ?? document.x);
  const administrativeCode = optionalCode(address.h_code);
  const legalCode = optionalCode(address.b_code);
  if (!administrativeCode && !legalCode) return null;

  const sido = canonicalSido(address.region_1depth_name);
  const district = address.region_2depth_name?.trim() ?? "";
  const neighborhood = (
    address.region_3depth_h_name?.trim() || address.region_3depth_name?.trim() || ""
  );
  const name = neighborhood || district || sido;
  if (!name) return null;

  try {
    const location = createForecastLocation({ name, latitude, longitude });
    const kind = administrativeCode ? "administrative-area" : "legal-area";
    const idCode = administrativeCode ?? legalCode;
    return {
      id: `kakao:${kind === "administrative-area" ? "h" : "b"}:${idCode}`,
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
}

async function fetchKakaoDocuments(
  query: string,
  apiKey: string,
  fetchImpl: typeof fetch,
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
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`location search returned HTTP ${response.status}`);
  const bytes = await readResponseBytes(response, {
    maxBytes: 256 * 1024,
    contentType: "application/json",
  });
  return documentsFrom(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
}

/** Search Korean administrative places without retaining the query or selected coordinates. */
export async function searchKoreanLocations(
  query: string,
  options: LocationSearchOptions = {},
): Promise<ForecastLocationSearchResult[]> {
  const normalized = query.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (normalized.length < 2) return [];
  if (normalized.length > 80) throw new RangeError("location query is too long");
  const apiKey = options.apiKey?.trim() || process.env.KAKAO_REST_API_KEY?.trim();
  if (!apiKey) throw new Error("Kakao location search is not configured");

  const upstreamQuery = KOREAN_CITY_ALIASES[normalized] ?? normalized;
  const queries = [upstreamQuery];
  if (upstreamQuery === normalized && !/[도시군구읍면동]$/.test(normalized)) {
    queries.push(`${normalized}동`);
  }

  for (const searchQuery of queries) {
    const unique = new Map<string, ForecastLocationSearchResult>();
    for (const document of await fetchKakaoDocuments(
      searchQuery,
      apiKey,
      options.fetchImpl ?? fetch,
    )) {
      const result = toResult(document);
      if (result && !unique.has(result.id)) unique.set(result.id, result);
    }
    if (unique.size > 0) return [...unique.values()];
  }
  return [];
}
