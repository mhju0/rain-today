import { cachedFetch } from "../cache.ts";
import { CACHE_TTL_MS, SEOUL } from "../seoul.ts";
import type {
  CurrentWeather,
  DailyForecast,
  HourlyForecast,
  NormalizedWarning,
  WeatherProviderStatus,
} from "../types";
import { conditionFromKma, extractWarnings, tmFcToIso } from "./kma-mapping.ts";
import { createWeatherProvider } from "./read.ts";

/**
 * 기상청 (Korea Meteorological Administration) — optional provider.
 *
 * Uses the official open APIs from 공공데이터포털 (data.go.kr). The keys are free.
 * The two services are SEPARATE 활용신청 (application approvals) on data.go.kr and
 * therefore use TWO INDEPENDENT environment variables — each service is optional
 * and verified on its own:
 *
 *  - KMA_SHORT_TERM_API_KEY → VilageFcstInfoService_2.0 (단기예보 조회서비스)
 *      · getUltraSrtNcst (초단기실황): live obs → current
 *      · getVilageFcst   (단기예보):   3-day → hourly + daily
 *  - KMA_WARNING_API_KEY    → WthrWrnInfoService (기상특보 조회서비스)
 *      · getWthrWrnList   (기상특보):   official warnings
 *
 * Both the "Encoding" and "Decoding" key formats work; keys are used
 * server-side only and are never logged, serialized, or returned to the client.
 * A missing short-term key disables only obs/forecast; a missing warning key
 * disables only warnings; neither is ever required for the public scene
 * (Open-Meteo is the zero-key fallback).
 */

const API_BASE = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0";
const WARN_BASE = "https://apis.data.go.kr/1360000/WthrWrnInfoService";

/**
 * data.go.kr issues both URL-encoded ("Encoding") and plain ("Decoding") keys;
 * normalize to plain so URLSearchParams encodes it exactly once (no double
 * encoding). Never logs or returns the value.
 */
function normalizeServiceKey(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  return v.includes("%") ? decodeURIComponent(v) : v;
}

/** Short-term forecast service key (VilageFcstInfoService_2.0) — obs/forecast only. */
function shortTermServiceKey(): string | null {
  return normalizeServiceKey(process.env.KMA_SHORT_TERM_API_KEY);
}

/** Weather-warning service key (WthrWrnInfoService) — 기상특보 only. */
function warningServiceKey(): string | null {
  return normalizeServiceKey(process.env.KMA_WARNING_API_KEY);
}

/**
 * Classification of a data.go.kr response that NEVER receives the API key, so it
 * is safe by construction — it inspects only HTTP status and the response body
 * (XML/JSON/plain-text error pages). Lets status/diagnostics distinguish an
 * empty-but-successful answer from a real authorization failure, a rate limit,
 * or a malformed request, instead of swallowing everything into "[]".
 */
export type KmaResultClass = "ok" | "empty" | "forbidden" | "rate-limited" | "error";

export interface KmaClassification {
  class: KmaResultClass;
  /** Short, key-free human detail for diagnostics/logs. */
  detail: string;
  /** Parsed JSON body when the response was valid JSON; undefined otherwise. */
  json?: KmaJsonResponse;
}

interface KmaJsonResponse {
  response: {
    header: { resultCode: string; resultMsg?: string };
    body?: { items?: { item?: unknown[] } };
  };
}

/** data.go.kr returnReasonCode / resultCode → our class. Key-free. */
function codeToClass(code: string): KmaResultClass {
  switch (code) {
    case "00":
      return "ok";
    case "03": // NODATA — a real success that simply has no rows
      return "empty";
    case "22": // LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS
      return "rate-limited";
    case "30": // SERVICE_KEY_IS_NOT_REGISTERED
    case "31": // DEADLINE_HAS_EXPIRED
    case "32": // UNREGISTERED_IP
      return "forbidden";
    default:
      return "error";
  }
}

/**
 * Classify a data.go.kr response from its HTTP status and raw body text. The key
 * is NOT a parameter, so it can never be leaked through this path.
 */
export function classifyKmaResponse(httpStatus: number, body: string): KmaClassification {
  const trimmed = body.trimStart();

  // Transport-level signals first.
  if (httpStatus === 429) return { class: "rate-limited", detail: "HTTP 429" };
  if (httpStatus === 401 || httpStatus === 403) {
    return { class: "forbidden", detail: `HTTP ${httpStatus}` };
  }

  // Non-JSON body: data.go.kr returns XML or plain "Forbidden"/"SERVICE ..."
  // even when dataType=JSON is requested (typically an auth/subscription issue).
  if (!trimmed.startsWith("{")) {
    const reason = /<returnReasonCode>\s*(\d+)\s*<\/returnReasonCode>/.exec(trimmed);
    if (reason) {
      const cls = codeToClass(reason[1]);
      return { class: cls === "ok" ? "error" : cls, detail: `returnReasonCode ${reason[1]}` };
    }
    if (/forbidden|service key|등록되지|미등록|unregistered/i.test(trimmed)) {
      return { class: "forbidden", detail: "non-JSON auth error" };
    }
    if (httpStatus >= 500) return { class: "error", detail: `HTTP ${httpStatus} non-JSON` };
    if (!httpStatus || httpStatus < 200 || httpStatus >= 300) {
      return { class: "error", detail: `HTTP ${httpStatus} non-JSON` };
    }
    return { class: "error", detail: "non-JSON response" };
  }

  // JSON body — trust resultCode.
  let json: KmaJsonResponse;
  try {
    json = JSON.parse(body) as KmaJsonResponse;
  } catch {
    return { class: "error", detail: "invalid JSON" };
  }
  const code = json.response?.header?.resultCode;
  if (typeof code !== "string") {
    if (httpStatus >= 500) return { class: "error", detail: `HTTP ${httpStatus}` };
    return { class: "error", detail: "missing resultCode" };
  }
  return { class: codeToClass(code), detail: `resultCode ${code}`, json };
}

/** Typed error so cached fetches can propagate a classification to status code. */
export class KmaError extends Error {
  readonly klass: Exclude<KmaResultClass, "ok" | "empty">;
  constructor(klass: Exclude<KmaResultClass, "ok" | "empty">, message: string) {
    super(message);
    this.name = "KmaError";
    this.klass = klass;
  }
}

/** KST wall clock (UTC+9, no DST). Read components with getUTC* only. */
function kstNow(): Date {
  return new Date(Date.now() + 9 * 3600_000);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/** 초단기실황 is published ~40 min past each hour. */
function ncstBase(): { baseDate: string; baseTime: string } {
  const t = kstNow();
  if (t.getUTCMinutes() < 45) t.setUTCHours(t.getUTCHours() - 1);
  return { baseDate: ymd(t), baseTime: `${pad(t.getUTCHours())}00` };
}

/** 단기예보 is issued at 02,05,…,23 KST; allow a 70-minute publication margin. */
function vilageBase(): { baseDate: string; baseTime: string } {
  const t = kstNow();
  const minutes = t.getUTCHours() * 60 + t.getUTCMinutes();
  const issueHours = [23, 20, 17, 14, 11, 8, 5, 2];
  const hour = issueHours.find((h) => minutes >= h * 60 + 70);
  if (hour === undefined) {
    t.setUTCDate(t.getUTCDate() - 1);
    return { baseDate: ymd(t), baseTime: "2300" };
  }
  return { baseDate: ymd(t), baseTime: `${pad(hour)}00` };
}

interface KmaItem {
  category: string;
  obsrValue?: string;
  fcstValue?: string;
  fcstDate?: string;
  fcstTime?: string;
}

async function callShortTerm(
  endpoint: string,
  base: { baseDate: string; baseTime: string },
): Promise<KmaItem[]> {
  const key = shortTermServiceKey();
  if (!key) throw new KmaError("forbidden", "KMA_SHORT_TERM_API_KEY not configured");
  const params = new URLSearchParams({
    serviceKey: key,
    dataType: "JSON",
    numOfRows: "1000",
    pageNo: "1",
    base_date: base.baseDate,
    base_time: base.baseTime,
    nx: String(SEOUL.kmaGrid.nx),
    ny: String(SEOUL.kmaGrid.ny),
  });
  const res = await fetch(`${API_BASE}/${endpoint}?${params}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  const c = classifyKmaResponse(res.status, text);
  if (c.class === "ok") {
    const items = (c.json?.response.body?.items?.item ?? []) as KmaItem[];
    return items;
  }
  if (c.class === "empty") return [];
  // forbidden | rate-limited | error — never include the key (it isn't in `detail`).
  throw new KmaError(c.class, `KMA short-term ${endpoint}: ${c.detail}`);
}

function kstIso(yyyymmdd: string, hhmm: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00+09:00`;
}

interface Snapshot {
  current: CurrentWeather;
  hourly: HourlyForecast[];
  daily: DailyForecast[];
}

const num = (v: string | undefined): number | null => {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) ? n : null;
};

async function fetchSnapshot(): Promise<Snapshot> {
  const [ncstItems, fcstItems] = await Promise.all([
    callShortTerm("getUltraSrtNcst", ncstBase()),
    callShortTerm("getVilageFcst", vilageBase()),
  ]);

  // --- hourly from 단기예보: pivot category rows into per-hour records ---
  const byHour = new Map<string, Record<string, string>>();
  for (const item of fcstItems) {
    if (!item.fcstDate || !item.fcstTime || item.fcstValue === undefined) continue;
    const key = `${item.fcstDate}${item.fcstTime}`;
    const slot = byHour.get(key) ?? {};
    slot[item.category] = item.fcstValue;
    byHour.set(key, slot);
  }

  const nowMs = Date.now();
  const hourly: HourlyForecast[] = [...byHour.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => ({ key, v, time: kstIso(key.slice(0, 8), key.slice(8)) }))
    .filter(({ time, v }) => Date.parse(time) >= nowMs - 30 * 60 * 1000 && v.TMP !== undefined)
    .slice(0, 24)
    .map(({ time, v }) => ({
      time,
      temperature: Number(v.TMP),
      precipitationProbability: num(v.POP),
      windSpeed: num(v.WSD) !== null ? Math.round(Number(v.WSD) * 3.6 * 10) / 10 : null,
      humidity: num(v.REH),
      condition: conditionFromKma(Number(v.PTY ?? 0), Number(v.SKY ?? 0)),
    }));

  // --- daily: aggregate forecast days that carry TMN/TMX ---
  const byDate = new Map<string, Record<string, string>[]>();
  for (const [key, v] of byHour) {
    const date = key.slice(0, 8);
    const list = byDate.get(date) ?? [];
    list.push({ ...v, _time: key.slice(8) });
    byDate.set(date, list);
  }
  const daily: DailyForecast[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([date, slots]) => {
      const tmn = slots.map((s) => num(s.TMN)).find((n) => n !== null);
      const tmx = slots.map((s) => num(s.TMX)).find((n) => n !== null);
      if (tmn == null || tmx == null) return [];
      const pops = slots.map((s) => num(s.POP)).filter((n): n is number => n !== null);
      const midday =
        slots.find((s) => s._time === "1200") ?? slots[Math.floor(slots.length / 2)];
      return [
        {
          date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
          temperatureMax: tmx,
          temperatureMin: tmn,
          precipitationProbability: pops.length ? Math.max(...pops) : null,
          condition: conditionFromKma(Number(midday?.PTY ?? 0), Number(midday?.SKY ?? 0)),
          sunrise: null,
          sunset: null,
        },
      ];
    });

  // --- current from 초단기실황 ---
  const obs: Record<string, string> = {};
  for (const item of ncstItems) {
    if (item.obsrValue !== undefined) obs[item.category] = item.obsrValue;
  }
  if (obs.T1H === undefined) throw new KmaError("error", "KMA: no observation data returned");
  const ncst = ncstBase();
  const pty = Number(obs.PTY ?? 0);
  const current: CurrentWeather = {
    time: kstIso(ncst.baseDate, ncst.baseTime),
    temperature: Number(obs.T1H),
    apparentTemperature: null,
    humidity: num(obs.REH),
    windSpeed: num(obs.WSD) !== null ? Math.round(Number(obs.WSD) * 3.6 * 10) / 10 : null,
    windDirection: num(obs.VEC),
    precipitation: num(obs.RN1),
    cloudCover: null,
    // 실황 has no SKY category — when it isn't raining, borrow the nearest forecast hour.
    condition: pty > 0 ? conditionFromKma(pty, 0) : (hourly[0]?.condition ?? "unknown"),
  };

  return { current, hourly, daily };
}

/**
 * Official 특보 (warnings) from WthrWrnInfoService/getWthrWrnList for the Seoul
 * station. The list endpoint returns issuance bulletins; we keep only the most
 * recent one (it states the current status) and run the defensive text parser.
 *
 * Uses KMA_WARNING_API_KEY — a SEPARATE data.go.kr 활용신청 from the short-term
 * forecast service. An empty list from a successful call is a legitimate
 * "no active warnings" result and is returned as []; an authorization failure,
 * rate limit, or malformed response throws a typed KmaError so the status layer
 * can report it honestly (and is NOT silently turned into "no warnings").
 */
async function fetchWarnings(): Promise<NormalizedWarning[]> {
  const key = warningServiceKey();
  if (!key) throw new KmaError("forbidden", "KMA_WARNING_API_KEY not configured");

  const to = ymd(kstNow());
  const past = kstNow();
  past.setUTCDate(past.getUTCDate() - 2);
  const from = ymd(past);

  const params = new URLSearchParams({
    serviceKey: key,
    dataType: "JSON",
    numOfRows: "50",
    pageNo: "1",
    stnId: String(SEOUL.kmaWarningStn),
    fromTmFc: from,
    toTmFc: to,
  });
  const res = await fetch(`${WARN_BASE}/getWthrWrnList?${params}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  const c = classifyKmaResponse(res.status, text);

  if (c.class === "empty") return []; // NODATA → no active warnings (a real success)
  if (c.class !== "ok") {
    // forbidden | rate-limited | error — propagate, never swallow into [].
    throw new KmaError(c.class, `KMA warning getWthrWrnList: ${c.detail}`);
  }

  const items = (c.json?.response.body?.items?.item ?? []) as Record<string, unknown>[];
  if (items.length === 0) return []; // OK with zero rows → no active warnings

  const tmOf = (it: Record<string, unknown>): string =>
    typeof it.tmFc === "string" ? it.tmFc : typeof it.tmFc === "number" ? String(it.tmFc) : "";
  const latestTm = items.map(tmOf).sort().at(-1) ?? "";
  const latest = items.filter((it) => tmOf(it) === latestTm);

  const out: NormalizedWarning[] = [];
  const seen = new Set<string>();
  for (const it of latest) {
    const blob = Object.values(it)
      .filter((v): v is string => typeof v === "string")
      .join("\n");
    for (const w of extractWarnings(blob, {
      issuedAt: tmFcToIso(latestTm || null),
      area: SEOUL.nameKo,
    })) {
      if (seen.has(w.id)) continue;
      seen.add(w.id);
      out.push(w);
    }
  }
  return out;
}

function getWarningsCached() {
  return cachedFetch("kma-warnings", CACHE_TTL_MS, fetchWarnings);
}

/**
 * Independent status for the 기상특보 (warning) capability. Reported separately
 * from the short-term forecast status so a missing/forbidden warning key never
 * disables obs/forecast, and vice versa. Distinguishes:
 *   needs-config (no key) · ok (live, incl. "no active warnings") · error (auth/rate/etc.)
 */
export async function getKmaWarningStatus(): Promise<WeatherProviderStatus> {
  const base: WeatherProviderStatus = {
    id: "kma",
    name: "기상청 특보 (KMA 기상특보)",
    availability: "ok",
    message: "대한민국 기상청 공식 기상특보",
    missingEnvVars: [],
    lastUpdated: null,
    fromCache: false,
  };
  if (!warningServiceKey()) {
    return {
      ...base,
      availability: "needs-config",
      missingEnvVars: ["KMA_WARNING_API_KEY"],
      message: "기상특보 조회서비스 키가 없습니다 (data.go.kr 활용신청 필요)",
    };
  }
  try {
    const result = await getWarningsCached();
    const count = result.value.length;
    return {
      ...base,
      fromCache: result.fromCache,
      stale: result.stale,
      message: result.stale
        ? "일시적 연결 오류 — 최근 캐시 데이터 표시 중"
        : count > 0
          ? `발효 중인 특보 ${count}건`
          : "발효 중인 특보 없음",
    };
  } catch (err) {
    const klass = err instanceof KmaError ? err.klass : "error";
    return {
      ...base,
      availability: "error",
      message:
        klass === "forbidden"
          ? "기상특보 키가 승인되지 않았습니다 (활용신청 상태를 확인하세요)"
          : klass === "rate-limited"
            ? "기상특보 API 호출 한도를 초과했습니다"
            : "기상특보 API 호출에 실패했습니다",
    };
  }
}

/** Independent fail-safe read for the authoritative warning feed. */
export async function getKmaWarnings(): Promise<NormalizedWarning[]> {
  if (!warningServiceKey()) return [];
  try {
    return (await getWarningsCached()).value;
  } catch {
    return []; // a warning fetch error must never disable forecast data
  }
}

export const kmaProvider = createWeatherProvider({
  id: "kma",
  name: "기상청 (KMA)",
  statusName: "기상청 단기예보 (KMA)",
  messages: {
    ok: "대한민국 기상청 공식 관측·예보 데이터",
    stale: "일시적 연결 오류 — 최근 캐시 데이터 표시 중",
    needsConfig: "단기예보 조회서비스 키가 없습니다 (data.go.kr 활용신청 필요)",
    error: "기상청 API 호출에 실패했습니다",
  },
  missingConfiguration: () => shortTermServiceKey() ? [] : ["KMA_SHORT_TERM_API_KEY"],
  ttlMs: CACHE_TTL_MS,
  load: fetchSnapshot,
  failureMessage(error) {
    const klass = error instanceof KmaError ? error.klass : "error";
    return klass === "forbidden"
      ? "단기예보 키가 승인되지 않았습니다 (활용신청 상태를 확인하세요)"
      : klass === "rate-limited"
        ? "단기예보 API 호출 한도를 초과했습니다"
        : "기상청 API 호출에 실패했습니다";
  },
});
