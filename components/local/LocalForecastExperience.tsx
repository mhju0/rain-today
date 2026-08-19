"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { CONDITION_LABELS_KO } from "@/lib/conditions";
import { periodNameForHour } from "@/lib/forecast/blocks";
import type { TimelineReading } from "@/lib/forecast/rainWindow";
import type { LocalForecastTimelineBlock, LocalForecastView } from "@/lib/localForecastView";
import {
  describeForecastLocationSelection,
  type ForecastLocationSelection,
} from "@/lib/locationPrecision";
import type { ForecastLocationSearchResult } from "@/lib/locationSearch";

type ViewState =
  | { kind: "idle" }
  | { kind: "loading"; label: string }
  | { kind: "ready"; forecast: LocalForecastView; selection: ForecastLocationSelection }
  // Carries the input to retry, or null when retrying can never help — so the
  // view cannot offer a button it has no way to act on.
  | { kind: "error"; message: string; retry: ChosenForecastLocation | null };

interface ChosenForecastLocation {
  name: string;
  latitude: number;
  longitude: number;
  elevationM: number | null;
  selection: ForecastLocationSelection;
}

const STORED_LOCATION_KEY = "raintoday.last-location.v1";
/** Pre-rename key. Read once so a returning visitor keeps their place. */
const LEGACY_LOCATION_KEY = "seoulsky.last-location.v1";
/** What the server returns when a device coordinate could not be named. */
const DEVICE_PLACEHOLDER_NAME = "현재 위치";

/**
 * The forecast coordinate was rejected by the service-area check, so the same
 * request can never succeed. Kept distinct from a transient failure so the page
 * does not offer a retry that is guaranteed to fail.
 */
class ForecastOutOfServiceAreaError extends Error {}

function normalizeLocationQuery(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function probabilityLabel(probability: number | null): string {
  if (probability === null) return "—";
  return `${Math.round(probability)}%`;
}

function rainAction(probability: number | null, amountMm: number | null): string {
  if (probability === null) return "강수 정보를 충분히 모으지 못했어요.";
  if (probability >= 70 || (amountMm ?? 0) >= 10) return "우산을 꼭 챙기세요.";
  if (probability >= 40) return "작은 우산을 챙기면 마음이 놓여요.";
  if (probability >= 20) return "오래 밖에 있다면 우산을 고려하세요.";
  return "우산 없이 나서도 괜찮아 보여요.";
}

function formatDate(date: string | null): string {
  if (!date) return "내일";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${date}T12:00:00+09:00`));
}

/**
 * "20 목" — six of these share one card, so the month is dropped. The card
 * already says these are the days after tomorrow, and a full "8. 20. (목)"
 * overflows its column at every width.
 */
function formatOutlookDate(date: string): string {
  const weekday = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    weekday: "narrow",
  }).format(new Date(`${date}T12:00:00+09:00`));
  // Off the ISO date rather than Intl: ko-KR renders `day: "numeric"` as "20일",
  // and "20일 목" is a third wider than the column it has to sit in.
  return `${Number(date.slice(8, 10))} ${weekday}`;
}

/**
 * Only a searched administrative area goes in the URL. A device fix is a
 * person's precise position, and putting it in the address bar would leak it
 * into browser history and into any link they shared; that one stays on the
 * device. Both are restored on the next visit.
 */
function shareableSearch(input: ChosenForecastLocation): string | null {
  if (input.selection.kind !== "area") return null;
  const params = new URLSearchParams({
    lat: input.latitude.toFixed(5),
    lon: input.longitude.toFixed(5),
    name: input.name,
    area: input.selection.areaKind === "legal-area" ? "b" : "h",
  });
  return `?${params}`;
}

function locationFromSearch(search: string): ChosenForecastLocation | null {
  const params = new URLSearchParams(search);
  const rawLat = params.get("lat");
  const rawLon = params.get("lon");
  const name = params.get("name")?.trim();
  const area = params.get("area");
  // Bail on absent coordinates before Number(), which turns null and "" into 0
  // and would send a link stripped by a chat client to the Gulf of Guinea —
  // surfacing a dead-end "outside the service area" error as the first screen.
  if (!rawLat?.trim() || !rawLon?.trim()) return null;
  const latitude = Number(rawLat);
  const longitude = Number(rawLon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  // Coarse Korea bounding box. The server still validates against the real
  // service-area geometry; this only keeps a malformed link out of the loading
  // state and on the chooser, where the user can do something about it.
  if (latitude < 32 || latitude > 39.5 || longitude < 124 || longitude > 132) return null;
  if (!name || name.length > 80) return null;
  return {
    name,
    latitude,
    longitude,
    elevationM: null,
    selection: {
      kind: "area",
      areaKind: area === "b" ? "legal-area" : "administrative-area",
    },
  };
}

function readStoredLocation(): ChosenForecastLocation | null {
  try {
    const raw = window.localStorage.getItem(STORED_LOCATION_KEY)
      ?? window.localStorage.getItem(LEGACY_LOCATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ChosenForecastLocation>;
    if (
      typeof parsed.name !== "string" ||
      typeof parsed.latitude !== "number" ||
      typeof parsed.longitude !== "number" ||
      !Number.isFinite(parsed.latitude) ||
      !Number.isFinite(parsed.longitude) ||
      !parsed.selection
    ) {
      return null;
    }
    return {
      name: parsed.name,
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      elevationM: typeof parsed.elevationM === "number" ? parsed.elevationM : null,
      selection: parsed.selection,
    };
  } catch {
    // Private-mode storage throws on read; a first run is the right fallback.
    return null;
  }
}

/**
 * Persist no more precision than the forecast can use.
 *
 * A raw device fix is accurate to a few metres, which is enough to identify a
 * dwelling, and browser storage is readable by anything running on this origin.
 * Three decimals is about 110 m — far finer than the 5 km KMA grid the forecast
 * is read on, so the restored forecast is identical while what sits on disk no
 * longer points at a front door.
 */
function coarsenForStorage(input: ChosenForecastLocation): ChosenForecastLocation {
  const round = (value: number): number => Math.round(value * 1_000) / 1_000;
  return { ...input, latitude: round(input.latitude), longitude: round(input.longitude) };
}

function writeStoredLocation(input: ChosenForecastLocation): void {
  try {
    window.localStorage.setItem(
      STORED_LOCATION_KEY,
      JSON.stringify(coarsenForStorage(input)),
    );
  } catch {
    // Persistence is a convenience; losing it must not break the forecast.
  }
}

function clearStoredLocation(): void {
  try {
    window.localStorage.removeItem(STORED_LOCATION_KEY);
    window.localStorage.removeItem(LEGACY_LOCATION_KEY);
  } catch {
    // Nothing to recover from — the next visit simply starts at the chooser.
  }
}

async function loadForecast(input: {
  name: string;
  latitude: number;
  longitude: number;
  elevationM: number | null;
}): Promise<LocalForecastView> {
  const response = await fetch("/api/local-forecast", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
  });
  // A 400 means the coordinate itself was rejected — almost always a position
  // outside the Korean service area. Telling that user to wait and retry would
  // send them round a loop that cannot end.
  if (response.status === 400) throw new ForecastOutOfServiceAreaError();
  if (!response.ok) throw new Error("forecast request failed");
  return response.json() as Promise<LocalForecastView>;
}

function LocationMark() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
      <circle cx="12" cy="12" r="7" />
    </svg>
  );
}

function SearchMark() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

export function LocationChooser({ onChoose, autoFocus = false, busy = false }: {
  onChoose(input: ChosenForecastLocation): void;
  autoFocus?: boolean;
  /** A forecast is loading over this view; dim it and take it out of the tab order. */
  busy?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ForecastLocationSearchResult[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const [activeResultIndex, setActiveResultIndex] = useState(-1);
  const [locating, setLocating] = useState(false);
  const listboxId = useId();
  const requestSequence = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Returning from a forecast puts the user back here on purpose, so land them
  // on the control they came back to use. Never on first paint — auto-focusing
  // a search field on load pops the keyboard on a phone.
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const visibleResults = expanded ? results : [];

  useEffect(() => {
    const normalized = normalizeLocationQuery(query);
    const sequence = requestSequence.current;
    if (normalized.length < 2) return;

    const controller = new AbortController();
    activeRequest.current = controller;

    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/locations/search?q=${encodeURIComponent(normalized)}`,
          { signal: controller.signal },
        );
        if (response.status === 429) {
          if (sequence !== requestSequence.current) return;
          setResults([]);
          setActiveResultIndex(-1);
          setRetryAvailable(true);
          setMessage("검색 요청이 많아요. 잠시 후 다시 시도해 주세요.");
          return;
        }
        if (response.status === 400) {
          // The server rejected the query itself, so retrying it unchanged
          // cannot succeed. Saying "temporarily unavailable" here would be
          // dishonest and would offer a retry that never helps.
          if (sequence !== requestSequence.current) return;
          setResults([]);
          setActiveResultIndex(-1);
          setRetryAvailable(false);
          setMessage("검색어를 인식하지 못했어요. 시·구·동 이름으로 더 짧게 입력해 주세요.");
          return;
        }
        if (response.status === 503) {
          // Distinguish "this deployment has no search credential" from a
          // passing upstream failure: only one of them is worth retrying.
          const reason = await response.clone().json().then(
            (body: { error?: unknown }) => body?.error,
            () => undefined,
          );
          if (sequence !== requestSequence.current) return;
          if (reason === "search_not_configured") {
            setResults([]);
            setActiveResultIndex(-1);
            setRetryAvailable(false);
            setMessage("이곳에서는 지역 검색을 쓸 수 없어요. 위의 ‘내 위치로 보기’를 사용해 주세요.");
            return;
          }
        }
        if (!response.ok) throw new Error("unavailable");
        const payload = (await response.json()) as { results: ForecastLocationSearchResult[] };
        if (sequence !== requestSequence.current) return;
        setResults(payload.results);
        setExpanded(true);
        setActiveResultIndex(payload.results.length > 0 ? 0 : -1);
        setRetryAvailable(false);
        setMessage(
          payload.results.length === 0
            ? "대한민국 안에서 일치하는 행정구역을 찾지 못했어요. 시·구·동을 함께 입력해 보세요."
            : null,
        );
      } catch {
        if (controller.signal.aborted || sequence !== requestSequence.current) return;
        setResults([]);
        setActiveResultIndex(-1);
        setRetryAvailable(true);
        setMessage("지역 검색이 잠시 원활하지 않아요. 다시 시도해 주세요.");
      } finally {
        if (sequence === requestSequence.current) setSearching(false);
      }
    }, 250);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [query, retryVersion]);

  const chooseSearchResult = (result: ForecastLocationSearchResult) => {
    requestSequence.current += 1;
    activeRequest.current?.abort();
    onChoose({
      // The fully qualified label, not the bare leaf: dozens of Korean towns
      // share a 동 name, and "중앙동" alone cannot confirm the right place.
      name: result.label || result.name,
      latitude: result.latitude,
      longitude: result.longitude,
      elevationM: result.elevationM,
      selection: { kind: "area", areaKind: result.kind },
    });
  };

  const useCurrentLocation = () => {
    setMessage(null);
    if (!navigator.geolocation) {
      setMessage("이 브라우저에서는 위치 기능을 사용할 수 없어요. 지역을 검색해 주세요.");
      return;
    }
    // A high-accuracy fix can take the full 12s timeout. Without this the button
    // itself gave no sign it had been pressed, and the only feedback was muted
    // text under a different control.
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => onChoose({
        name: DEVICE_PLACEHOLDER_NAME,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        elevationM:
          position.coords.altitude !== null && Number.isFinite(position.coords.altitude)
            ? position.coords.altitude
            : null,
        selection: {
          kind: "device",
          accuracyM:
            Number.isFinite(position.coords.accuracy) && position.coords.accuracy >= 0
              ? position.coords.accuracy
              : null,
        },
      }),
      () => {
        setLocating(false);
        setMessage("위치를 확인하지 못했어요. 권한을 확인하거나 지역을 검색해 주세요.");
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 0 },
    );
  };

  return (
    <section
      className={`local-chooser${busy ? " is-busy" : ""}`}
      aria-labelledby="location-heading"
      inert={busy || undefined}
    >
      <div className="local-chooser-copy">
        <p className="local-eyebrow">KOREA · LOCAL RAIN FORECAST</p>
        {/* Day-agnostic on purpose: the forecast now opens on today and carries
            tomorrow beside it, so naming one day in the promise would be wrong
            again the moment the other is on screen. */}
        <h1 id="location-heading">비, 여기서는<br />어떨까요?</h1>
        <p>
          여러 날씨 서비스를 한곳에서 비교하고, 가까운 관측소에서 최근 실제로
          얼마나 맞았는지에 따라 예보의 영향을 조정합니다.
        </p>
      </div>

      <div className="local-location-actions">
        <button
          className="local-primary-button"
          type="button"
          onClick={useCurrentLocation}
          disabled={locating}
          aria-busy={locating}
        >
          <span className="local-button-icon"><LocationMark /></span>
          {locating ? "위치 확인 중…" : "내 위치로 보기"}
        </button>

        <div className="local-divider"><span>또는 지역 직접 찾기</span></div>

        {/* The combobox and its popup share a positioning context so the result
            list can leave the flow. In the flow it resized the document on every
            keystroke, and iOS Safari answered that by rescrolling under the
            keyboard — the page visibly walked while you typed. */}
        <div className="local-search">
        <form
          className="local-search-form"
          onSubmit={(event) => {
            event.preventDefault();
            const selected = visibleResults[activeResultIndex];
            if (selected) {
              chooseSearchResult(selected);
            } else if (query.trim().length < 2) {
              setMessage("지역 이름을 두 글자 이상 입력해 주세요.");
            }
          }}
        >
          <label htmlFor="location-search" className="sr-only">대한민국 지역 검색</label>
          <SearchMark />
          <input
            id="location-search"
            ref={inputRef}
            value={query}
            onChange={(event) => {
              const nextQuery = event.target.value;
              const normalized = normalizeLocationQuery(nextQuery);
              requestSequence.current += 1;
              activeRequest.current?.abort();
              setQuery(nextQuery);
              setResults([]);
              setExpanded(true);
              setActiveResultIndex(-1);
              setSearching(normalized.length >= 2);
              setRetryAvailable(false);
              setMessage(
                normalized.length === 1 ? "지역 이름을 두 글자 이상 입력해 주세요." : null,
              );
            }}
            placeholder="동네, 도시 이름 검색"
            autoComplete="off"
            maxLength={80}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={visibleResults.length > 0}
            aria-controls={listboxId}
            aria-activedescendant={
              activeResultIndex >= 0 ? `${listboxId}-option-${activeResultIndex}` : undefined
            }
            aria-busy={searching}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && results.length > 0) {
                event.preventDefault();
                // Re-opening a list the user dismissed is the whole point of
                // collapsing rather than discarding it.
                if (!expanded) {
                  setExpanded(true);
                  setActiveResultIndex(0);
                  return;
                }
                setActiveResultIndex((current) => (current + 1) % results.length);
              } else if (event.key === "ArrowUp" && results.length > 0) {
                event.preventDefault();
                if (!expanded) {
                  setExpanded(true);
                  setActiveResultIndex(results.length - 1);
                  return;
                }
                setActiveResultIndex((current) => current <= 0 ? results.length - 1 : current - 1);
              } else if (event.key === "Enter" && visibleResults[activeResultIndex]) {
                event.preventDefault();
                chooseSearchResult(visibleResults[activeResultIndex]);
              } else if (event.key === "Escape") {
                // Collapse the popup and keep the matches, per the combobox
                // pattern — discarding them left no way back but retyping.
                setExpanded(false);
                setActiveResultIndex(-1);
                setRetryAvailable(false);
                setMessage(null);
              }
            }}
          />
          <button type="submit" disabled={searching || activeResultIndex < 0}>
            {searching ? "찾는 중" : "선택"}
          </button>
        </form>

        <div className="local-search-popup">
        {searching && (
          <p className="local-form-message" role="status">지역 검색 중…</p>
        )}

        {!searching && message && (
          <div className="local-form-status">
            <p className="local-form-message" role="status">{message}</p>
            {retryAvailable && (
              <button
                type="button"
                onClick={() => {
                  requestSequence.current += 1;
                  setSearching(true);
                  setRetryAvailable(false);
                  setMessage(null);
                  setRetryVersion((current) => current + 1);
                }}
              >
                다시 시도
              </button>
            )}
          </div>
        )}

        <ul
          id={listboxId}
          className="local-search-results"
          aria-label="대한민국 행정구역 검색 결과"
          role="listbox"
          hidden={visibleResults.length === 0}
        >
          {visibleResults.map((result, index) => (
            <li
              id={`${listboxId}-option-${index}`}
              key={result.id}
              role="option"
              aria-selected={index === activeResultIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseSearchResult(result)}
              onMouseEnter={() => setActiveResultIndex(index)}
            >
              <span>{result.label}</span>
              <small>
                {result.alternateName ? `법정동 ${result.alternateName}` : "대표 위치"}
              </small>
            </li>
          ))}
        </ul>
        </div>
        </div>

        <p className="local-privacy-note">
          현재 위치 좌표는 예보를 위해 서버와 날씨 제공사에 전송되며, 계정이나 DB에
          저장하지 않습니다. 다시 열었을 때 바로 보여드리려고 마지막으로 선택한 위치만
          이 기기에 저장합니다. 예보 데이터는 좌표 기반으로 서버 메모리에 잠시 캐시될
          수 있습니다. 지역 검색어는 Kakao에 전달되며, 검색 응답은 저장하지 않습니다.
          <span>검색 결과는 행정구역 또는 법정구역 대표 위치 · 지역 검색 Kakao Map</span>
        </p>
      </div>
    </section>
  );
}

/** Days the provider called wrong, over the days it was scored. */
function missedDays(score: LocalForecastView["evidence"]["scores"][number]): string {
  const missed = score.misses + score.falseAlarms;
  if (score.windowSampleCount <= 0) return `${missed}일`;
  return `${score.windowSampleCount}일 중 ${missed}일`;
}

/** The wet-day miss rate — where the real difference between services lives. */
function seedMissLabel(score: LocalForecastView["evidence"]["seedScores"][number]): string {
  if (score.wetDays <= 0) return "—";
  return `비 온 ${score.wetDays}일 중 ${score.misses}일`;
}

function benchmarkVerdict(
  benchmark: NonNullable<LocalForecastView["evidence"]["benchmark"]>,
): string | null {
  const { adaptiveBrier, equalBrier } = benchmark;
  if (adaptiveBrier === null || equalBrier === null) return null;
  if (adaptiveBrier < equalBrier) {
    return "최근 기록에서는 성능을 반영한 예보가 단순 평균보다 더 잘 맞았습니다.";
  }
  if (adaptiveBrier > equalBrier) {
    return "최근 기록에서는 단순 평균이 더 잘 맞아, 지금은 가중치를 세게 적용하지 않습니다.";
  }
  return "최근 기록에서는 두 방식이 비슷하게 맞았습니다.";
}

function PerformanceEvidence({ evidence, cohortLabel }: {
  evidence: LocalForecastView["evidence"];
  cohortLabel: string;
}) {
  const {
    status,
    statusLabel,
    station,
    comparisonSampleCount,
    emptyMessage,
    emptyDetail,
    scores,
    seedScores,
    benchmark,
  } = evidence;
  // Best-first by wet-day miss rate, matching the live table's "가장 잘 맞음" order.
  const seedRanked = [...seedScores].sort(
    (a, b) => a.misses / Math.max(1, a.wetDays) - b.misses / Math.max(1, b.wetDays),
  );
  // Rank only the providers that actually have a seven-day record, and only
  // against each other. Falling back to the 30-day score let a provider with no
  // recent history be labelled "가장 잘 맞음" under a 최근 7일 heading.
  const recent = scores
    .filter((score) => score.last7DaysBrier !== null)
    .sort((a, b) => (a.last7DaysBrier ?? 0) - (b.last7DaysBrier ?? 0));
  const unranked = scores.filter((score) => score.last7DaysBrier === null);
  const ranked = [...recent, ...unranked];
  const rankLabel = (score: LocalForecastView["evidence"]["scores"][number]): string => {
    const position = recent.indexOf(score);
    if (position < 0) return "최근 7일 기록 없음";
    return position === 0 ? "가장 잘 맞음" : `${position + 1}번째`;
  };
  const verdict = benchmark ? benchmarkVerdict(benchmark) : null;

  return (
    <section className="local-evidence-section" aria-labelledby="evidence-heading">
      <div className="local-section-heading">
        <div>
          <p className="local-eyebrow">RECENT LOCAL PERFORMANCE</p>
          <h2 id="evidence-heading">
            {seedRanked.length > 0
              ? <>과거 기록에서<br />누가 더 잘 맞았나</>
              : <>최근 이 지역에서<br />누가 더 잘 맞았나</>}
          </h2>
        </div>
        <span className={`local-status-pill is-${status}`}>{statusLabel}</span>
      </div>

      <div className="local-evidence-meta">
        <div>
          <span>비교 관측소</span>
          <strong>{station ? `${station.name} · ${station.distanceKm.toFixed(1)}km` : "아직 연결되지 않음"}</strong>
        </div>
        <div>
          <span>채점 기간</span>
          {/* The recency half-life applies to live captures only. Seed evidence is
              a flat retrospective sample, so claiming it here would be false. */}
          <strong>
            {seedRanked.length > 0
              ? "과거 예보 기록 · 기간 전체를 같은 비중으로 반영"
              : "최근 30일 · 최근 예보일수록 크게 반영"}
          </strong>
        </div>
        <div>
          <span>비교한 예보</span>
          <strong>
            {comparisonSampleCount > 0
              ? seedRanked.length > 0
                ? `${comparisonSampleCount}일`
                : `${comparisonSampleCount}회 · ${cohortLabel}`
              : "수집 전"}
          </strong>
        </div>
      </div>

      {emptyMessage === null && seedRanked.length > 0 ? (
        <>
          <div className="local-score-table" role="table" aria-label="서비스별 과거 강수 예보 기록">
            <div className="local-score-row local-score-header" role="row">
              <span role="columnheader">서비스</span>
              <span role="columnheader">비를 놓친 날</span>
              <span role="columnheader">헛예보</span>
            </div>
            {seedRanked.map((provider) => (
              <div className="local-score-row" role="row" key={provider.id}>
                <strong role="cell">{provider.name}</strong>
                <span role="cell">{seedMissLabel(provider)}</span>
                <span role="cell">{provider.falseAlarms}일</span>
              </div>
            ))}
          </div>
          <p className="local-method-note">
            이 지역의 실시간 비교가 쌓이기 전이라, 과거 예보 기록으로 각 서비스를
            채점했습니다. ‘비를 놓친 날’은 실제로 비가 온 날 중 그 서비스가 비를
            예보하지 않은 날입니다. 확률이 아닌 예상 강수량으로만 채점했고, 이 지역에서
            실제 관측이 쌓이면 이 추정을 대체합니다.
          </p>
        </>
      ) : emptyMessage === null ? (
        <>
          <div className="local-score-table" role="table" aria-label="서비스별 최근 강수 예보 성능">
            <div className="local-score-row local-score-header" role="row">
              <span role="columnheader">서비스</span>
              <span role="columnheader">최근 7일</span>
              <span role="columnheader">빗나간 날</span>
            </div>
            {ranked.map((provider) => (
              <div className="local-score-row" role="row" key={provider.id}>
                <strong role="cell">{provider.name}</strong>
                <span role="cell">{rankLabel(provider)}</span>
                <span role="cell">{missedDays(provider)}</span>
              </div>
            ))}
          </div>

          <details className="local-score-detail">
            <summary>채점 원자료 자세히 보기</summary>
            <div className="local-score-scroll">
              <div className="local-score-table is-raw" role="table" aria-label="서비스별 채점 원자료">
                <div className="local-score-row local-score-header" role="row">
                  <span role="columnheader">서비스</span>
                  <span role="columnheader">최근 7일 Brier</span>
                  <span role="columnheader">30일 Brier</span>
                  <span role="columnheader">누락 · 오보</span>
                  <span role="columnheader">비 온 날 강수량 오차</span>
                </div>
                {ranked.map((provider) => (
                  <div className="local-score-row" role="row" key={provider.id}>
                    <strong role="cell">{provider.name}</strong>
                    <span role="cell">{provider.last7DaysBrier?.toFixed(3) ?? "—"}</span>
                    <span role="cell">{provider.windowBrier.toFixed(3)}</span>
                    <span role="cell">누락 {provider.misses} · 오보 {provider.falseAlarms}</span>
                    <span role="cell">
                      {provider.rainyAmountMae === null ? "—" : `${provider.rainyAmountMae.toFixed(1)} mm`}
                      {provider.rainyAmountSampleCount > 0 && ` · ${provider.rainyAmountSampleCount}일`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <p className="local-method-note">
              Brier 점수는 예보 확률이 실제와 얼마나 어긋났는지를 0에 가까울수록 좋게
              나타냅니다. ‘누락’은 비가 왔는데 낮게 본 날, ‘오보’는 비가 오지 않았는데
              높게 본 날입니다. 오전·오후 발표를 섞지 않고, 비가 오지 않은 날도 모두
              포함합니다. 최근 성능은 확률 예보의 영향만 조정하며 정확성을 보장하지
              않습니다.
            </p>
          </details>
        </>
      ) : (
        <div className="local-empty-evidence">
          <strong>{emptyMessage}</strong>
          {emptyDetail && <p>{emptyDetail}</p>}
        </div>
      )}

      {verdict && (
        <p className="local-benchmark-line">
          <b>{verdict}</b>
          <span>
            미리 정해둔 방식으로 두 계산법을 나란히 채점했습니다 · 성능 반영{" "}
            {benchmark?.adaptiveBrier?.toFixed(3) ?? "—"} · 단순 평균{" "}
            {benchmark?.equalBrier?.toFixed(3) ?? "—"}
          </span>
        </p>
      )}
    </section>
  );
}

/** "31° / 23°", with an em dash wherever a provider published no value. */
function formatRange(high: number | null, low: number | null): string {
  const one = (value: number | null) => (value === null ? "—" : `${Math.round(value)}°`);
  return `${one(high)} / ${one(low)}`;
}

/** "0.121 vs 0.134" — only when both sides of the benchmark actually scored. */
function benchmarkPair(benchmark: LocalForecastView["evidence"]["benchmark"]): string {
  if (!benchmark || benchmark.adaptiveBrier === null || benchmark.equalBrier === null) return "—";
  return `${benchmark.adaptiveBrier.toFixed(3)} vs ${benchmark.equalBrier.toFixed(3)}`;
}

/**
 * One block's one-line reading. Kept factual rather than advisory: the umbrella
 * advice belongs to the day, and repeating it eight times would assert an
 * hourly recommendation the daily blend never made.
 */
function blockHint(
  block: LocalForecastTimelineBlock,
  role: "onset" | "peak" | "wet" | "dry",
): string {
  if (block.precipMax === null) return "아직 발표되지 않았습니다. 0%가 아니라 값이 없는 것입니다.";
  if (role === "onset") return "여기서 비가 시작됩니다.";
  if (role === "peak") return "가장 높은 시간대입니다.";
  if (role === "wet") return "비 구간입니다.";
  if (block.precipMax === 0) return "비 예보 없음.";
  return "기준 아래입니다.";
}

/**
 * "오후 1시", "자정" — a Korean period name pairs with a 12-hour number, so the
 * raw 24-hour clock the blocks carry ("오후 13시") reads as a mistake.
 */
function clockLabel(hour: number): string {
  if (hour === 0) return "자정";
  const period = periodNameForHour(hour);
  return `${period} ${hour % 12 === 0 ? 12 : hour % 12}시`;
}

/** The rain window as the sentence the page leads with. */
function RainSentence({ run, endsTomorrow }: {
  run: TimelineReading["firstRun"];
  endsTomorrow: boolean;
}) {
  if (!run) return <>앞으로 24시간, <b>비 소식은 없습니다</b></>;
  const onset = run.startIndex === 0
    ? "지금부터"
    : `${run.startsTomorrow ? "내일 " : ""}${clockLabel(run.startHour)}부터`;
  if (!run.endsWithinWindow) {
    return <>비는 <b>{onset}</b><span className="local-answer-dim">, </span>예보 끝까지 이어집니다</>;
  }
  return (
    <>
      비는 <b>{onset}</b>
      <span className="local-answer-dim">, </span>
      <b>{endsTomorrow && !run.startsTomorrow ? "내일 " : ""}{clockLabel(run.endHour)}까지</b>
    </>
  );
}

function ForecastDashboard({ forecast, selection, onReset }: {
  forecast: LocalForecastView;
  selection: ForecastLocationSelection;
  onReset(): void;
}) {
  const locationDescription = describeForecastLocationSelection(selection);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const learned = forecast.blendMode === "learned";
  // Seed influence is real influence, so the bars are shown — but it comes from
  // past archives, not from measured skill at this station, and must not be
  // described as "최근 관측 성능".
  const seeded = forecast.blendMode === "seed";
  const weighted = learned || seeded;
  // Normalise first: an absent field is not the same as an explicit null, and
  // testing the raw value would report "오늘" while rendering tomorrow's numbers.
  const today = forecast.today ?? null;
  const tomorrow = forecast.recommendation;
  const timeline = forecast.timeline;
  const blocks = timeline?.blocks ?? [];
  const run = timeline?.reading.firstRun ?? null;
  const laterRun = timeline?.reading.laterRun ?? null;
  const peak = timeline?.reading.peak ?? null;

  // Which KST day each block belongs to, counted off the date dividers the view
  // model already marked. Lets the sentence say "내일 6시" when the run opens
  // today and closes after midnight.
  const dayOffsets: number[] = [];
  let dayOffset = 0;
  for (const block of blocks) {
    if (block.dayTag) dayOffset += 1;
    dayOffsets.push(dayOffset);
  }

  const spread = forecast.influence
    .map((provider) => provider.probability)
    .filter((probability): probability is number => probability !== null);
  const influenceMax = Math.max(...forecast.influence.map((p) => p.influence), 0);

  // The chooser this replaced is gone from the DOM, so without this the whole
  // swap leaves focus on <body> and a keyboard user restarts from the top.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <main className="local-dashboard">
      <div className="local-strip">
        <div className="local-strip-place">
          <span className="local-strip-pin" aria-hidden><LocationMark /></span>
          <b>{forecast.locationName}</b>
          {/* With a resolved place name, the source says how we got it. Without
              one it only repeats the name — "현재 위치 · 현재 기기 위치" tells the
              reader nothing — so show the accuracy instead. */}
          <span className="local-strip-meta">
            {forecast.locationName === DEVICE_PLACEHOLDER_NAME
              ? locationDescription.precision
              : `${locationDescription.source} · ${locationDescription.precision}`}
          </span>
        </div>
        <div className="local-strip-now">
          {forecast.current && (
            <>
              <span className="local-strip-temp">{Math.round(forecast.current.temperature)}°</span>
              <span className="local-strip-meta">
                {CONDITION_LABELS_KO[forecast.current.condition]} · KST
              </span>
            </>
          )}
          <button type="button" onClick={onReset}>위치 바꾸기</button>
        </div>
      </div>

      <section className="local-answer" aria-labelledby="forecast-heading">
        <p className="local-eyebrow">앞으로 24시간</p>
        <h1 id="forecast-heading" ref={headingRef} tabIndex={-1}>
          {timeline
            ? <RainSentence run={run} endsTomorrow={run !== null && dayOffsets[run.endIndex] > 0} />
            : <>{today ? "오늘" : "내일"} 비가 올까요?</>}
        </h1>
        {timeline && (
          <p className="local-answer-sub">
            {peak && <span>최대 <b className="is-wet">{Math.round(peak.probability)}%</b> · {peak.rangeLabel}</span>}
            {run && <span>지속 <b>{run.durationHours}시간</b></span>}
            {tomorrow.precipitationAmountMm !== null && (
              <span>내일 예상 강수량 <b>{tomorrow.precipitationAmountMm.toFixed(1)} mm</b></span>
            )}
            <span>{timeline.threshold}% 넘는 시간대를 비 구간으로 봅니다</span>
          </p>
        )}
        <p className="local-answer-action">
          {rainAction(
            (today ?? tomorrow).precipitationProbability,
            (today ?? tomorrow).precipitationAmountMm,
          )}
          {laterRun && ` 이후 ${laterRun.startsTomorrow ? "내일 " : ""}${laterRun.startHour}시부터 다시 비 구간입니다.`}
        </p>
      </section>

      {timeline && (
        <section className="local-ribbon" aria-labelledby="ribbon-heading">
          <div className="local-ribbon-head">
            <h2 id="ribbon-heading" className="local-ribbon-src">
              <i aria-hidden />시간대 강수확률 · {timeline.sourceName} 단독 예보
            </h2>
            <span className="local-ribbon-note">
              3시간 블록 {blocks.length}개
            </span>
          </div>

          <div className="local-ribbon-scroll">
            <div className="local-ribbon-grid" style={{ "--cols": blocks.length } as CSSProperties}>
              {blocks.map((block, index) => {
                const probability = block.precipMax;
                const empty = probability === null;
                const isOnset = run !== null && index === run.startIndex;
                const isPeak = probability !== null && peak !== null && probability === peak.probability;
                const role = empty ? "dry" : isOnset ? "onset" : isPeak ? "peak" : block.wet ? "wet" : "dry";
                return (
                  <div
                    className={`local-ribbon-col${block.wet ? " is-wet" : ""}${block.dayTag ? " is-daybreak" : ""}`}
                    key={block.rangeLabel}
                  >
                    {block.dayTag && <span className="local-ribbon-daytag">{block.dayTag}</span>}
                    <span className="local-ribbon-chead">
                      <span className="local-ribbon-per">{block.label}</span>
                      <span className="local-ribbon-rng">{block.rangeLabel}</span>
                    </span>
                    <span
                      className={`local-ribbon-track${empty ? " is-na" : ""}`}
                      style={{ "--threshold": `${timeline.threshold}%` } as CSSProperties}
                    >
                      {index === 0 && (
                        <span className="local-ribbon-rule" aria-hidden>{timeline.threshold}%</span>
                      )}
                      {probability === null
                        ? <span className="local-ribbon-na">미발표</span>
                        : (
                          <span
                            className={`local-ribbon-bar${probability === 0 ? " is-zero" : ""}`}
                            style={{ "--h": `${Math.round(probability)}%` } as CSSProperties}
                          />
                        )}
                    </span>
                    <span className="local-ribbon-cfoot">
                      <span className={`local-ribbon-val${empty ? " is-na" : ""}`}>
                        {probability === null ? "—" : <>{Math.round(probability)}<span>%</span></>}
                      </span>
                      <span className="local-ribbon-hint">{blockHint(block, role)}</span>
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="local-ribbon-axis" aria-hidden>
              {blocks.map((block) => <span key={block.rangeLabel}>{block.startHour}</span>)}
              <span>{blocks[blocks.length - 1].endHour}시</span>
            </div>
          </div>
          <p className="local-ribbon-swipe">← 옆으로 밀어 24시간 전체 보기</p>
        </section>
      )}

      <div className="local-days">
        {today && (
          <section className="local-day" aria-labelledby="today-heading">
            <div className="local-day-head">
              <h2 id="today-heading" className="local-day-when">
                오늘 <span>{formatDate(today.date)}</span>
              </h2>
              <span className="local-tag">{forecast.comparedProviderCount}개 서비스 동일 비중</span>
            </div>
            <p className="local-day-value">
              {today.precipitationProbability === null
                ? "—"
                : <>{Math.round(today.precipitationProbability)}<span>%</span></>}
            </p>
            <p className="local-day-row">
              <span>{today.precipitationAmountMm === null ? "—" : `${today.precipitationAmountMm.toFixed(1)} mm`}</span>
              <span>{formatRange(today.temperatureMax, today.temperatureMin)}</span>
              <span>{CONDITION_LABELS_KO[today.condition]}</span>
            </p>
            {/* The learned profile scores next-day forecasts only, so today's
                number is always a plain average — claiming otherwise would
                assert an accuracy nothing has measured. */}
            <p className="local-day-why">
              오늘은 <b>성능 가중을 쓰지 않습니다.</b> 관측소 기록은 익일 예보만 채점하므로,
              오늘 숫자에 얹으면 검증되지 않은 정확도 주장이 됩니다.
            </p>
          </section>
        )}

        <section
          className={`local-day${weighted ? " is-weighted" : ""}`}
          aria-labelledby="tomorrow-heading"
        >
          <div className="local-day-head">
            <h2 id="tomorrow-heading" className="local-day-when">
              내일 <span>{formatDate(forecast.targetDate)}</span>
            </h2>
            <span className={`local-tag${weighted ? " is-weighted" : ""}`}>
              {forecast.comparedProviderCount}개 서비스{" "}
              {weighted ? (seeded ? "과거 기록 가중" : "성능 가중") : "동일 비중"}
            </span>
          </div>
          <p className="local-day-value">
            {tomorrow.precipitationProbability === null
              ? "—"
              : <>{Math.round(tomorrow.precipitationProbability)}<span>%</span></>}
          </p>
          <p className="local-day-row">
            <span>{tomorrow.precipitationAmountMm === null ? "—" : `${tomorrow.precipitationAmountMm.toFixed(1)} mm`}</span>
            <span>{formatRange(tomorrow.temperatureMax, tomorrow.temperatureMin)}</span>
            <span>{CONDITION_LABELS_KO[tomorrow.condition]}</span>
          </p>
          <p className="local-day-why">
            {seeded
              ? "이 지역의 실시간 비교가 쌓이기 전이라, 과거 예보 기록으로 추정한 적중률을 일부만 반영했습니다."
              : learned
                ? <>관측소 {forecast.evidence.station?.name ?? "근처 관측소"}의 <b>{forecast.evidence.comparisonSampleCount}일 기록</b>을 반영했습니다.</>
                : "아직 이 지역의 성능 기록이 없어 서비스를 동일 비중으로 평균했습니다."}
            {timeline && " 위 리본과는 계산도 출처도 다릅니다."}
          </p>
        </section>
      </div>

      <div className="local-evidence-cards">
        <section className="local-card" aria-labelledby="station-heading">
          <div className="local-card-head">
            <h2 id="station-heading">관측소 대조</h2>
            <b>{forecast.evidence.station?.name ?? "미연결"}</b>
          </div>
          <dl className="local-kv">
            <dt>거리</dt>
            <dd>
              {forecast.evidence.station
                ? `${forecast.evidence.station.distanceKm.toFixed(1)} km`
                : "—"}
            </dd>
            <dt>비교 완료</dt>
            <dd>{forecast.evidence.comparisonSampleCount}일</dd>
            <dt>코호트</dt>
            <dd>{forecast.cohortLabel}</dd>
            <dt>기상청 격자</dt>
            <dd>5 km</dd>
            <dt>벤치마크</dt>
            <dd>{benchmarkPair(forecast.evidence.benchmark)}</dd>
          </dl>
          <p className="local-card-why">
            {forecast.evidence.emptyMessage ?? "관측소는 근처 기록일 뿐, 당신이 서 있는 위치가 아닙니다."}
          </p>
        </section>

        <section className="local-card" aria-labelledby="influence-heading">
          <div className="local-card-head">
            <h2 id="influence-heading">서비스 {forecast.comparedProviderCount}곳 · 내일</h2>
            {spread.length > 1 && (
              <b>편차 {Math.round(Math.min(...spread))}–{Math.round(Math.max(...spread))}%</b>
            )}
          </div>
          <div className="local-prov">
            {forecast.influence.map((provider) => (
              <div
                className={`local-prow${weighted && provider.influence === influenceMax ? " is-best" : ""}`}
                key={provider.id}
              >
                <span className="local-prow-n">{provider.name}</span>
                <span
                  className="local-meter"
                  style={{ "--w": `${Math.round(provider.influence * 100)}%` } as CSSProperties}
                  aria-label={`${Math.round(provider.influence * 100)}% 영향`}
                >
                  <i />
                </span>
                <span className="local-prow-v">{probabilityLabel(provider.probability)}</span>
              </div>
            ))}
          </div>
          <p className="local-card-why">
            {weighted
              ? <>막대는 이번 예보에서 각 서비스가 차지한 영향입니다. {seeded ? "과거 기록으로 추정한 적중률" : "최근 이 지역의 적중률"}에 따라 비중이 다릅니다.</>
              : "아직 이 지역의 성능 기록이 없어, 모든 서비스를 똑같은 비중으로 평균했습니다."}
          </p>
        </section>

        {forecast.outlook.length > 1 && (
          <section className="local-card" aria-labelledby="outlook-heading">
            <div className="local-card-head">
              <h2 id="outlook-heading">{forecast.outlook.length}일 전망</h2>
              <b>동일 비중</b>
            </div>
            <div className="local-week">
              {forecast.outlook.map((day) => (
                <div className="local-wd" key={day.date}>
                  <span className="local-wd-d">{formatOutlookDate(day.date)}</span>
                  <span className="local-wd-b">
                    <i style={{ "--h": `${Math.round(day.precipitationProbability ?? 0)}%` } as CSSProperties} />
                  </span>
                  <span className="local-wd-v">{probabilityLabel(day.precipitationProbability)}</span>
                </div>
              ))}
            </div>
            <p className="local-card-why">
              성능 가중은 <b>내일 하루에만</b> 적용됩니다. 모레부터는 서비스를 그대로 평균한 값입니다.
            </p>
          </section>
        )}
      </div>

      <PerformanceEvidence evidence={forecast.evidence} cohortLabel={forecast.cohortLabel} />

      <footer className="local-footer">
        <p>출처 Open-Meteo · MET Norway · 기상청 · Pirate Weather · WeatherAPI 중 응답한 서비스 · 모든 시각 KST</p>
        <p>관측 검증: 기상청 ASOS · 사용자 위치는 서버에 저장하지 않음</p>
        {timeline && (
          <p>
            시간대 확률은 {timeline.sourceName} 한 곳의 값이고, 오늘·내일 확률은 여러 곳을 섞은
            값입니다. 같은 주장이 아닙니다.
          </p>
        )}
      </footer>
    </main>
  );
}

export default function LocalForecastExperience() {
  const [state, setState] = useState<ViewState>({ kind: "idle" });
  const [returningToChooser, setReturningToChooser] = useState(false);
  const chooseRef = useRef<((input: ChosenForecastLocation, push: boolean) => void) | null>(null);
  // Every path out of the loading screen bumps this. A response that arrives
  // after the user has left must not paint a dashboard over the view they went
  // to, leaving the URL and stored location describing something else.
  const generation = useRef(0);
  // Whether what is on screen is the place this device saved. A forecast opened
  // from someone else's share link is not, so dismissing it must not delete the
  // user's own saved location.
  const showingStoredLocation = useRef(false);

  const chooseLocation = async (input: ChosenForecastLocation, push = true) => {
    const attempt = (generation.current += 1);
    setState({ kind: "loading", label: input.name });
    try {
      const { selection, ...forecastInput } = input;
      const forecast = await loadForecast(forecastInput);
      if (attempt !== generation.current) return;
      // Commit to history and storage only once the coordinate is known to
      // work. Saving first meant a permanently rejected coordinate reproduced
      // its own error screen on every later visit.
      if (push && typeof window !== "undefined") {
        const search = shareableSearch(input);
        window.history.pushState(
          { raintodayView: "forecast", location: input },
          "",
          search ?? window.location.pathname,
        );
        writeStoredLocation(input);
        showingStoredLocation.current = true;
      }
      setState({ kind: "ready", forecast, selection });
    } catch (error) {
      if (attempt !== generation.current) return;
      setState(
        error instanceof ForecastOutOfServiceAreaError
          ? {
              kind: "error",
              message: "이 위치는 대한민국 서비스 지역 밖이에요. 대한민국 안의 지역을 검색해 주세요.",
              retry: null,
            }
          : {
              kind: "error",
              message: "이 위치의 예보를 불러오지 못했어요.",
              retry: input,
            },
      );
    }
  };
  // Declared before the mount effect so it has already run when the restore
  // below fires, and re-run every render so popstate always calls the current
  // closure rather than the one captured on mount.
  useEffect(() => {
    chooseRef.current = (input, push) => void chooseLocation(input, push);
  });

  const returnToChooser = (push: boolean) => {
    generation.current += 1;
    // Dismissing the saved place is a statement that it is not the place, so it
    // clears the restore. Dismissing someone else's share link is not, and must
    // leave this device's own saved location alone.
    if (showingStoredLocation.current) {
      clearStoredLocation();
      showingStoredLocation.current = false;
    }
    if (push && typeof window !== "undefined") {
      window.history.pushState({ raintodayView: "chooser" }, "", window.location.pathname);
    }
    setReturningToChooser(true);
    setState({ kind: "idle" });
  };

  // Restore on arrival: a link with coordinates wins, then whatever this device
  // last looked at. Without either, the chooser is the honest first screen.
  useEffect(() => {
    const fromLink = locationFromSearch(window.location.search);
    const stored = fromLink ? null : readStoredLocation();
    const restored = fromLink ?? stored;
    if (restored) {
      showingStoredLocation.current = stored !== null;
      // Stamp the entry the user landed on, so going Back to it later restores
      // this forecast instead of falling through to the chooser.
      window.history.replaceState(
        { raintodayView: "forecast", location: restored },
        "",
        window.location.href,
      );
      chooseRef.current?.(restored, false);
    }

    const onPopState = (event: PopStateEvent) => {
      const entry = event.state as
        | { raintodayView?: string; location?: ChosenForecastLocation }
        | null;
      // A device fix carries no query string, so its history entry is
      // indistinguishable from the chooser's by URL alone. The pushed state is
      // what tells them apart.
      if (entry?.raintodayView === "chooser") {
        generation.current += 1;
        setReturningToChooser(true);
        setState({ kind: "idle" });
        return;
      }
      const target = locationFromSearch(window.location.search)
        ?? (entry?.raintodayView === "forecast" ? entry.location ?? null : null);
      if (target) {
        chooseRef.current?.(target, false);
      } else {
        generation.current += 1;
        setReturningToChooser(true);
        setState({ kind: "idle" });
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Lifted out of the JSX so the narrowing survives into the click handler.
  const errorRetry = state.kind === "error" ? state.retry : null;

  const announcement = state.kind === "loading"
    ? `${state.label}의 예보를 불러오는 중입니다.`
    : state.kind === "ready"
      ? `${state.forecast.locationName}의 ${state.forecast.today ? "오늘" : "내일"} 예보를 표시했습니다.`
      : state.kind === "error"
        ? state.message
        : "";

  return (
    <div className="local-forecast-page">

      {/* One region that outlives every view swap. Mounting the status inside
          the view that replaces it meant the arrival was never announced. */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      <header className="local-site-header">
        <button
          type="button"
          onClick={() => returnToChooser(true)}
          aria-label="처음으로 · 위치 다시 선택"
        >
          <span className="local-wordmark">오늘비</span>
          <small>전국 로컬 예보</small>
        </button>
        <span className="local-live-mark"><i /> KST · LIVE SOURCES</span>
      </header>

      {(state.kind === "idle" || state.kind === "loading") && (
        <LocationChooser
          autoFocus={returningToChooser}
          onChoose={(input) => void chooseLocation(input)}
          busy={state.kind === "loading"}
        />
      )}

      {/* An overlay, not a replacement: unmounting the whole page left a black
          screen with one line on it, which reads as a crash on a slow phone.
          No role here — the persistent region above already announces this, and
          two announcers read one change out twice. */}
      {state.kind === "loading" && (
        <div className="local-loading is-overlay">
          <span />
          <p>{state.label}의 예보를 비교하고 있어요.</p>
        </div>
      )}

      {state.kind === "error" && (
        <div className="local-loading">
          <p>{state.message}</p>
          <div className="local-error-actions">
            {/* A provider being briefly down says nothing about the location,
                so retrying the same one is the first thing to offer. */}
            {errorRetry && (
              <button type="button" onClick={() => void chooseLocation(errorRetry, false)}>
                다시 시도
              </button>
            )}
            <button type="button" onClick={() => returnToChooser(false)}>다른 위치 선택</button>
          </div>
        </div>
      )}

      {state.kind === "ready" && (
        <ForecastDashboard
          forecast={state.forecast}
          selection={state.selection}
          onReset={() => returnToChooser(true)}
        />
      )}
    </div>
  );
}
