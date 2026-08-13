import { cachedFetch } from "../cache";
import { koreanAqiBand } from "../airQuality";
import {
  DEFAULT_KOREAN_LOCATION,
  koreanLocationCacheKey,
  type KoreanLocation,
} from "../location";
import { SEOUL } from "../seoul";
import type { NormalizedAirQuality, WeatherProviderStatus } from "../types";

/**
 * Air-quality sources, fused with priority: AirKorea (official, optional) →
 * Open-Meteo Air Quality (zero-key) → none. Used only to *subtly* shape the
 * scene's haze; never required for the public page.
 *
 * Open-Meteo AQ is keyless and the live default. AirKorea needs a separate
 * 공공데이터포털 key (AIRKOREA_API_KEY) for ArpltnInforInqireSvc; without it (or
 * if the key isn't subscribed to that service) we silently fall back.
 */

const AQ_TTL_MS = 20 * 60 * 1000; // moderate cache — AQ updates roughly hourly

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** "YYYY-MM-DD HH:MM" / "YYYY-MM-DDTHH:MM" (KST wall-clock) → ISO +09:00. */
function kstIso(t: string): string {
  return `${t.replace(" ", "T")}:00+09:00`;
}

// ─── Open-Meteo Air Quality (zero-key) ──────────────────────────────────────

async function fetchOpenMeteoAq(location: KoreanLocation): Promise<NormalizedAirQuality> {
  const params = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    current: "pm2_5,pm10,ozone,nitrogen_dioxide,aerosol_optical_depth,dust,uv_index",
    timezone: location.timezone,
  });
  const res = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${params}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Open-Meteo AQ HTTP ${res.status}`);
  const data = (await res.json()) as { current?: Record<string, unknown> };
  const c = data.current ?? {};
  const pm25 = num(c.pm2_5);
  const pm10 = num(c.pm10);
  return {
    pm25,
    pm10,
    ozone: num(c.ozone),
    no2: num(c.nitrogen_dioxide),
    aerosolOpticalDepth: num(c.aerosol_optical_depth),
    dust: num(c.dust),
    uvIndex: num(c.uv_index),
    band: koreanAqiBand(pm25, pm10),
    station: null,
    observedAt: typeof c.time === "string" ? kstIso(c.time) : null,
    source: "open-meteo-air-quality",
    stale: false,
  };
}

const openMeteoAqCached = (location: KoreanLocation) =>
  cachedFetch(
    `open-meteo-aq:${koreanLocationCacheKey(location)}`,
    AQ_TTL_MS,
    () => fetchOpenMeteoAq(location),
  );

// ─── AirKorea (official, optional) ──────────────────────────────────────────

function airKoreaKey(): string | null {
  return process.env.AIRKOREA_API_KEY?.trim() || null;
}

/** Numeric AirKorea value, treating "" / "-" / non-numeric as null. */
function akNum(v: unknown): number | null {
  const s = typeof v === "string" ? v.trim() : v;
  if (s === "" || s === "-" || s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function fetchAirKorea(): Promise<NormalizedAirQuality> {
  const key = airKoreaKey();
  if (!key) throw new Error("AirKorea: AIRKOREA_API_KEY not configured");
  const params = new URLSearchParams({
    serviceKey: key,
    returnType: "json",
    numOfRows: "1",
    pageNo: "1",
    stationName: SEOUL.airKoreaStation,
    dataTerm: "DAILY",
    ver: "1.3",
  });
  const res = await fetch(
    `https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getMsrstnAcctoRltmMesureDnsty?${params}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`AirKorea HTTP ${res.status}`);
  if (!text.trimStart().startsWith("{")) {
    // Plain "Forbidden" / XML when the key isn't subscribed to ArpltnInforInqireSvc.
    throw new Error("AirKorea non-JSON response (service not subscribed?)");
  }
  const json = JSON.parse(text) as {
    response?: { body?: { items?: Record<string, unknown>[] } };
  };
  const item = json.response?.body?.items?.[0];
  if (!item) throw new Error("AirKorea: no station items");
  const pm25 = akNum(item.pm25Value);
  const pm10 = akNum(item.pm10Value);
  const grade = akNum(item.khaiGrade);
  const band =
    grade === 1 || grade === 2 || grade === 3 || grade === 4
      ? (grade as 1 | 2 | 3 | 4)
      : koreanAqiBand(pm25, pm10);
  return {
    pm25,
    pm10,
    // AirKorea reports O3/NO2 in ppm (different unit from Open-Meteo µg/m³); we
    // keep only the scene-relevant particulates normalized and leave the rest null.
    ozone: null,
    no2: null,
    aerosolOpticalDepth: null,
    dust: null,
    uvIndex: null,
    band,
    station: SEOUL.airKoreaStation,
    observedAt: typeof item.dataTime === "string" ? kstIso(item.dataTime) : null,
    source: "airkorea",
    stale: false,
  };
}

const airKoreaCached = () => cachedFetch("airkorea", AQ_TTL_MS, fetchAirKorea);

// ─── Fusion ─────────────────────────────────────────────────────────────────

/** Fused current air quality: AirKorea (if configured) → Open-Meteo AQ → null. */
export async function getFusedAirQuality(
  location: KoreanLocation = DEFAULT_KOREAN_LOCATION,
): Promise<NormalizedAirQuality | null> {
  const centralSeoul = koreanLocationCacheKey(location) === koreanLocationCacheKey(DEFAULT_KOREAN_LOCATION);
  if (centralSeoul && airKoreaKey()) {
    try {
      const r = await airKoreaCached();
      return { ...r.value, stale: r.stale };
    } catch {
      // fall through to the keyless source
    }
  }
  try {
    const r = await openMeteoAqCached(location);
    return { ...r.value, stale: r.stale };
  } catch {
    return null; // no air-quality influence
  }
}

/** Per-source status for /diagnostics (does not gate the public scene). */
export async function airQualityStatuses(
  location: KoreanLocation = DEFAULT_KOREAN_LOCATION,
): Promise<WeatherProviderStatus[]> {
  const out: WeatherProviderStatus[] = [];
  const centralSeoul = koreanLocationCacheKey(location) === koreanLocationCacheKey(DEFAULT_KOREAN_LOCATION);

  // AirKorea (optional)
  if (!centralSeoul) {
    out.push({
      id: "airkorea",
      name: "AirKorea (한국환경공단)",
      availability: "unavailable",
      message: "이 위치의 공식 측정소 매칭은 아직 제공되지 않습니다",
      missingEnvVars: [],
      lastUpdated: null,
      fromCache: false,
    });
  } else if (!airKoreaKey()) {
    out.push({
      id: "airkorea",
      name: "AirKorea (한국환경공단)",
      availability: "needs-config",
      message: "AIRKOREA_API_KEY를 설정하면 공식 측정소 관측이 추가됩니다",
      missingEnvVars: ["AIRKOREA_API_KEY"],
      lastUpdated: null,
      fromCache: false,
    });
  } else {
    try {
      const r = await airKoreaCached();
      out.push({
        id: "airkorea",
        name: "AirKorea (한국환경공단)",
        availability: "ok",
        message: `측정소 ${r.value.station ?? SEOUL.airKoreaStation}`,
        missingEnvVars: [],
        lastUpdated: r.value.observedAt,
        fromCache: r.fromCache,
        stale: r.stale,
      });
    } catch {
      out.push({
        id: "airkorea",
        name: "AirKorea (한국환경공단)",
        availability: "error",
        message: "AirKorea 연결/구독 실패 — Open-Meteo 대기질로 대체",
        missingEnvVars: [],
        lastUpdated: null,
        fromCache: false,
      });
    }
  }

  // Open-Meteo Air Quality (keyless baseline)
  try {
    const r = await openMeteoAqCached(location);
    out.push({
      id: "open-meteo-air-quality",
      name: "Open-Meteo 대기질",
      availability: "ok",
      message: "키 없는 대기질 폴백 (PM2.5/PM10/먼지/AOD/UV)",
      missingEnvVars: [],
      lastUpdated: r.value.observedAt,
      fromCache: r.fromCache,
      stale: r.stale,
    });
  } catch {
    out.push({
      id: "open-meteo-air-quality",
      name: "Open-Meteo 대기질",
      availability: "error",
      message: "Open-Meteo 대기질 연결 실패",
      missingEnvVars: [],
      lastUpdated: null,
      fromCache: false,
    });
  }

  return out;
}
