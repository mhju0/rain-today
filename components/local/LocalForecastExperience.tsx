"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CONDITION_LABELS_KO } from "@/lib/conditions";
import type { LocalForecastView } from "@/lib/localForecastView";
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

const STORED_LOCATION_KEY = "seoulsky.last-location.v1";
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

function formatOutlookDate(date: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    weekday: "short",
    month: "numeric",
    day: "numeric",
  }).format(new Date(`${date}T12:00:00+09:00`));
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
    const raw = window.localStorage.getItem(STORED_LOCATION_KEY);
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

        <p className="local-privacy-note">
          현재 위치 좌표는 예보를 위해 서버와 날씨 제공사에 전송되며, 계정이나 DB에
          저장하지 않습니다. 다시 열었을 때 바로 보여드리려고 마지막으로 선택한 위치만
          이 기기에 저장합니다. 예보 데이터는 좌표 기반으로 서버 메모리에 잠시 캐시될
          수 있습니다. 지역 검색어는 Kakao에 전달되고 검색 응답은 최대 5분 캐시될 수
          있습니다.
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
    benchmark,
  } = evidence;
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
          <h2 id="evidence-heading">최근 이 지역에서<br />누가 더 잘 맞았나</h2>
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
          <strong>최근 30일 · 최근 예보일수록 크게 반영</strong>
        </div>
        <div>
          <span>비교한 예보</span>
          <strong>
            {comparisonSampleCount > 0 ? `${comparisonSampleCount}회 · ${cohortLabel}` : "수집 전"}
          </strong>
        </div>
      </div>

      {emptyMessage === null ? (
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

function ForecastDashboard({ forecast, selection, onReset }: {
  forecast: LocalForecastView;
  selection: ForecastLocationSelection;
  onReset(): void;
}) {
  const locationDescription = describeForecastLocationSelection(selection);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const learned = forecast.blendMode === "learned";
  // Lead with today — it is what someone opening a weather app is asking. Fall
  // back to tomorrow only when no provider still publishes a daily entry for
  // today, so the hero is never empty.
  // Normalise first: an absent field is not the same as an explicit null, and
  // testing the raw value would report "오늘" while rendering tomorrow's numbers.
  const today = forecast.today ?? null;
  const leadIsToday = today !== null;
  const lead = today ?? {
    date: forecast.targetDate ?? "",
    precipitationProbability: forecast.recommendation.precipitationProbability,
    precipitationAmountMm: forecast.recommendation.precipitationAmountMm,
    temperatureMax: forecast.recommendation.temperatureMax,
    temperatureMin: forecast.recommendation.temperatureMin,
    condition: forecast.recommendation.condition,
  };
  const probability = lead.precipitationProbability;
  const dayWord = leadIsToday ? "오늘" : "내일";

  // The chooser this replaced is gone from the DOM, so without this the whole
  // swap leaves focus on <body> and a keyboard user restarts from the top.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <main className="local-dashboard">
      <div className="local-dashboard-topline">
        <div className="local-topline-place">
          <span>{forecast.locationName}</span>
          {/* With a resolved place name, "현재 기기 위치" says how we got it.
              Without one it only repeats the name — "현재 위치 · 현재 기기 위치"
              tells the reader nothing — so show the accuracy instead. */}
          <small>
            {forecast.locationName === DEVICE_PLACEHOLDER_NAME
              ? locationDescription.precision
              : locationDescription.source}
          </small>
        </div>
        {forecast.current && (
          <p className="local-now">
            <span>지금</span>
            <strong>{Math.round(forecast.current.temperature)}°</strong>
            <small>{CONDITION_LABELS_KO[forecast.current.condition]}</small>
          </p>
        )}
        <button type="button" onClick={onReset}>위치 바꾸기</button>
      </div>

      <section className="local-forecast-hero" aria-labelledby="forecast-heading">
        <div className="local-forecast-intro">
          <p className="local-eyebrow">
            {formatDate(lead.date)} · {leadIsToday ? "TODAY" : "TOMORROW"}
          </p>
          <h1 id="forecast-heading" ref={headingRef} tabIndex={-1}>{dayWord} 비 올 확률</h1>
          <p className="local-hero-condition">{CONDITION_LABELS_KO[lead.condition]}</p>
          <p className="local-action-copy">
            {rainAction(probability, lead.precipitationAmountMm)}
          </p>
        </div>

        <div className="local-rain-number" aria-label={`강수 확률 ${probabilityLabel(probability)}`}>
          <span>{probability === null ? "—" : Math.round(probability)}</span>
          {probability !== null && <small>%</small>}
        </div>

        <div className="local-forecast-facts">
          <div><span>예상 강수량</span><strong>{lead.precipitationAmountMm === null ? "—" : `${lead.precipitationAmountMm.toFixed(1)} mm`}</strong></div>
          <div><span>낮 / 밤</span><strong>{lead.temperatureMax === null ? "—" : `${Math.round(lead.temperatureMax)}°`} / {lead.temperatureMin === null ? "—" : `${Math.round(lead.temperatureMin)}°`}</strong></div>
          <div>
            <span>계산 방식</span>
            {/* The learned profile scores next-day forecasts only, so today's
                number is always a plain average — claiming otherwise would
                assert an accuracy nothing has measured. */}
            <strong>{!leadIsToday && learned ? "최근 관측 성능 반영" : "서비스 동일 비중 평균"}</strong>
          </div>
        </div>

        <p className="local-hero-note">
          강수 확률은 {dayWord} 하루 중 비가 올 가능성입니다. 비가 내리는 시간이나 지역
          면적이 아닙니다.
        </p>
      </section>

      {leadIsToday && (
        <section className="local-tomorrow" aria-labelledby="tomorrow-heading">
          <div className="local-tomorrow-head">
            <p className="local-eyebrow">{formatDate(forecast.targetDate)} · TOMORROW</p>
            <h2 id="tomorrow-heading">내일 비 올 확률</h2>
          </div>
          <p className="local-tomorrow-figure">
            <strong>{probabilityLabel(forecast.recommendation.precipitationProbability)}</strong>
            <span>{CONDITION_LABELS_KO[forecast.recommendation.condition]}</span>
            <small>
              {forecast.recommendation.temperatureMax === null ? "—" : `${Math.round(forecast.recommendation.temperatureMax)}°`}
              {" / "}
              {forecast.recommendation.temperatureMin === null ? "—" : `${Math.round(forecast.recommendation.temperatureMin)}°`}
            </small>
          </p>
          <p className="local-tomorrow-note">
            {learned
              ? "내일 예보에만 최근 이 지역의 관측 성능을 반영합니다."
              : "아직 이 지역의 성능 기록이 없어 서비스를 동일 비중으로 평균했습니다."}
          </p>
        </section>
      )}

      {forecast.outlook.length > 1 && (
        <section className="local-outlook-section" aria-labelledby="outlook-heading">
          <div className="local-section-heading local-outlook-heading">
            <div>
              <p className="local-eyebrow">{forecast.outlook.length} DAY OUTLOOK</p>
              <h2 id="outlook-heading">그다음 날씨</h2>
            </div>
            <p>검증된 익일 범위 밖의 날짜는 서비스별 동일 비중으로 비교합니다.</p>
          </div>
          <div className="local-outlook-grid">
            {forecast.outlook.map((day) => (
              <div className="local-outlook-day" key={day.date}>
                <span>{formatOutlookDate(day.date)}</span>
                <strong>{probabilityLabel(day.precipitationProbability)}</strong>
                <em>{CONDITION_LABELS_KO[day.condition]}</em>
                <small>
                  {day.temperatureMax === null ? "—" : `${Math.round(day.temperatureMax)}°`}
                  {" / "}
                  {day.temperatureMin === null ? "—" : `${Math.round(day.temperatureMin)}°`}
                </small>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="local-precision-summary" aria-label="예보 위치 정밀도">
        <div><span>위치 기준</span><strong>{locationDescription.precision}</strong></div>
        <div><span>기상청 단기예보</span><strong>5 km 격자</strong></div>
        <div>
          <span>비교 관측소</span>
          <strong>
            {forecast.evidence.station
              ? `${forecast.evidence.station.name} · ${forecast.evidence.station.distanceKm.toFixed(1)} km`
              : "아직 연결되지 않음"}
          </strong>
        </div>
      </div>

      <section className="local-influence-section" aria-labelledby="influence-heading">
        <div className="local-section-heading">
          <div>
            <p className="local-eyebrow">PROVIDER INFLUENCE</p>
            <h2 id="influence-heading">이번 예보에<br />각 서비스가 미친 영향</h2>
          </div>
          <p>{forecast.comparedProviderCount}개 서비스의 익일 강수 확률을 비교했습니다.</p>
        </div>

        {learned ? (
          <div className="local-influence-grid">
            {forecast.influence.map((provider) => (
              <div className="local-influence-row" key={provider.id}>
                <div>
                  <strong>{provider.name}</strong>
                  <span>{probabilityLabel(provider.probability)}</span>
                </div>
                <div
                  className="local-weight-track"
                  aria-label={`${Math.round(provider.influence * 100)}% 영향`}
                >
                  <span style={{ width: `${provider.influence * 100}%` }} />
                </div>
                <b>{Math.round(provider.influence * 100)}%</b>
              </div>
            ))}
          </div>
        ) : (
          <>
            {/* Equal weights make every bar identical, which reads as a chart
                that failed to load. Say it in words and show the spread. */}
            <p className="local-influence-note">
              아직 이 지역의 성능 기록이 없어, 모든 서비스를 똑같은 비중으로
              평균했습니다. 각 서비스가 내놓은 내일 강수 확률은 이렇습니다.
            </p>
            <div className="local-influence-grid is-equal">
              {forecast.influence.map((provider) => (
                <div className="local-influence-row is-equal" key={provider.id}>
                  <strong>{provider.name}</strong>
                  <b>{probabilityLabel(provider.probability)}</b>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <PerformanceEvidence evidence={forecast.evidence} cohortLabel={forecast.cohortLabel} />

      <footer className="local-footer">
        <p>예보 비교: Open-Meteo · MET Norway · 기상청 · Pirate Weather · WeatherAPI 중 응답한 서비스</p>
        <p>관측 검증: 기상청 ASOS · 사용자 위치는 서버에 저장하지 않음</p>
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
          { seoulskyView: "forecast", location: input },
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
      window.history.pushState({ seoulskyView: "chooser" }, "", window.location.pathname);
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
        { seoulskyView: "forecast", location: restored },
        "",
        window.location.href,
      );
      chooseRef.current?.(restored, false);
    }

    const onPopState = (event: PopStateEvent) => {
      const entry = event.state as
        | { seoulskyView?: string; location?: ChosenForecastLocation }
        | null;
      // A device fix carries no query string, so its history entry is
      // indistinguishable from the chooser's by URL alone. The pushed state is
      // what tells them apart.
      if (entry?.seoulskyView === "chooser") {
        generation.current += 1;
        setReturningToChooser(true);
        setState({ kind: "idle" });
        return;
      }
      const target = locationFromSearch(window.location.search)
        ?? (entry?.seoulskyView === "forecast" ? entry.location ?? null : null);
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
      <div className="local-atmosphere" aria-hidden><span /><span /><span /></div>

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
          <span className="local-wordmark">SEOULSKY</span>
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
