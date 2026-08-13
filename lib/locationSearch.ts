import { readResponseBytes } from "./httpResponse.ts";
import { createKoreanLocation } from "./location.ts";

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const KOREAN_CITY_ALIASES: Readonly<Record<string, string>> = {
  서울: "Seoul",
  부산: "Busan",
  대구: "Daegu",
  인천: "Incheon",
  광주: "Gwangju",
  대전: "Daejeon",
  울산: "Ulsan",
  세종: "Sejong",
  수원: "Suwon",
  춘천: "Chuncheon",
  강릉: "Gangneung",
  청주: "Cheongju",
  전주: "Jeonju",
  포항: "Pohang",
  창원: "Changwon",
  제주: "Jeju",
} as const;

export interface KoreanLocationSearchResult {
  id: string;
  name: string;
  label: string;
  latitude: number;
  longitude: number;
  elevationM: number | null;
}

interface GeocodingResult {
  id?: number;
  name?: string;
  latitude?: number;
  longitude?: number;
  elevation?: number;
  country_code?: string;
  admin1?: string;
  admin2?: string;
  admin3?: string;
}

function upstreamRows(raw: unknown): GeocodingResult[] {
  if (!raw || typeof raw !== "object") return [];
  const results = (raw as { results?: unknown }).results;
  return Array.isArray(results) ? (results as GeocodingResult[]) : [];
}

/** Search Korean place names without retaining the query or selected coordinates. */
export async function searchKoreanLocations(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KoreanLocationSearchResult[]> {
  const normalized = query.normalize("NFKC").trim();
  if (normalized.length < 2) return [];
  if (normalized.length > 80) throw new RangeError("location query is too long");
  const upstreamQuery = KOREAN_CITY_ALIASES[normalized] ?? normalized;
  const params = new URLSearchParams({
    name: upstreamQuery,
    count: "8",
    language: "ko",
    countryCode: "KR",
    format: "json",
  });
  const response = await fetchImpl(`${GEOCODING_URL}?${params}`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`location search returned HTTP ${response.status}`);
  const bytes = await readResponseBytes(response, {
    maxBytes: 256 * 1024,
    contentType: "application/json",
  });
  const raw = JSON.parse(new TextDecoder().decode(bytes)) as unknown;

  return upstreamRows(raw).flatMap((row) => {
    if (
      row.country_code !== "KR" ||
      typeof row.id !== "number" ||
      typeof row.name !== "string" ||
      typeof row.latitude !== "number" ||
      typeof row.longitude !== "number"
    ) {
      return [];
    }
    try {
      const location = createKoreanLocation({
        name: row.name,
        latitude: row.latitude,
        longitude: row.longitude,
      });
      const label = Array.from(
        new Set([location.name, row.admin3, row.admin2, row.admin1].filter(Boolean)),
      ).join(", ");
      return [{
        id: String(row.id),
        name: location.name,
        label,
        latitude: location.latitude,
        longitude: location.longitude,
        elevationM:
          typeof row.elevation === "number" && Number.isFinite(row.elevation)
            ? row.elevation
            : null,
      }];
    } catch {
      return [];
    }
  });
}
