"use client";

import { useMemo, useState } from "react";
import type { LocalForecastResponse } from "@/lib/localForecast";
import type { KoreanLocationSearchResult } from "@/lib/locationSearch";

type ViewState =
  | { kind: "idle" }
  | { kind: "loading"; label: string }
  | { kind: "ready"; forecast: LocalForecastResponse }
  | { kind: "error"; message: string };

const PROVIDER_SHORT_NAMES: Readonly<Record<string, string>> = {
  "open-meteo": "Open-Meteo",
  "met-norway": "MET Norway",
  kma: "기상청",
  "pirate-weather": "Pirate Weather",
  "weather-api": "WeatherAPI",
};

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

function coordinateLabel(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
}

async function loadForecast(input: {
  name: string;
  latitude: number;
  longitude: number;
  elevationM: number | null;
}): Promise<LocalForecastResponse> {
  const params = new URLSearchParams({
    name: input.name,
    lat: String(input.latitude),
    lon: String(input.longitude),
  });
  if (input.elevationM !== null) params.set("elevation", String(input.elevationM));
  const response = await fetch(`/api/local-forecast?${params}`, { cache: "no-store" });
  if (!response.ok) throw new Error("forecast request failed");
  return response.json() as Promise<LocalForecastResponse>;
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

function LocationChooser({ onChoose }: {
  onChoose(input: {
    name: string;
    latitude: number;
    longitude: number;
    elevationM: number | null;
  }): void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KoreanLocationSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const useCurrentLocation = () => {
    setMessage(null);
    if (!navigator.geolocation) {
      setMessage("이 브라우저에서는 위치 기능을 사용할 수 없어요. 지역을 검색해 주세요.");
      return;
    }
    setMessage("정확한 위치를 확인하고 있어요…");
    navigator.geolocation.getCurrentPosition(
      (position) => onChoose({
        name: "현재 위치",
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        elevationM:
          position.coords.altitude !== null && Number.isFinite(position.coords.altitude)
            ? position.coords.altitude
            : null,
      }),
      () => setMessage("위치를 확인하지 못했어요. 권한을 확인하거나 지역을 검색해 주세요."),
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 0 },
    );
  };

  const search = async () => {
    const normalized = query.trim();
    if (normalized.length < 2) {
      setMessage("지역 이름을 두 글자 이상 입력해 주세요.");
      return;
    }
    setSearching(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/locations/search?q=${encodeURIComponent(normalized)}`);
      if (!response.ok) throw new Error("location search failed");
      const payload = (await response.json()) as { results: KoreanLocationSearchResult[] };
      setResults(payload.results);
      if (payload.results.length === 0) setMessage("대한민국 안에서 일치하는 지역을 찾지 못했어요.");
    } catch {
      setMessage("지역 검색이 잠시 원활하지 않아요. 다시 시도해 주세요.");
    } finally {
      setSearching(false);
    }
  };

  return (
    <section className="local-chooser" aria-labelledby="location-heading">
      <div className="local-chooser-copy">
        <p className="local-eyebrow">KOREA · LOCAL RAIN FORECAST</p>
        <h1 id="location-heading">내일 비,<br />여기서는 어떨까요?</h1>
        <p>
          여러 날씨 서비스를 한곳에서 비교하고, 가까운 관측소에서 최근 실제로
          얼마나 맞았는지에 따라 예보의 영향을 조정합니다.
        </p>
      </div>

      <div className="local-location-actions">
        <button className="local-primary-button" type="button" onClick={useCurrentLocation}>
          <span className="local-button-icon"><LocationMark /></span>
          내 위치로 보기
        </button>

        <div className="local-divider"><span>또는 지역 직접 찾기</span></div>

        <form
          className="local-search-form"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <label htmlFor="location-search" className="sr-only">대한민국 지역 검색</label>
          <SearchMark />
          <input
            id="location-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="동네, 도시 이름 검색"
            autoComplete="off"
            maxLength={80}
          />
          <button type="submit" disabled={searching}>{searching ? "찾는 중" : "검색"}</button>
        </form>

        {message && <p className="local-form-message" role="status">{message}</p>}

        {results.length > 0 && (
          <ul className="local-search-results" aria-label="검색 결과">
            {results.map((result) => (
              <li key={result.id}>
                <button
                  type="button"
                  onClick={() => onChoose({
                    name: result.name,
                    latitude: result.latitude,
                    longitude: result.longitude,
                    elevationM: result.elevationM,
                  })}
                >
                  <span>{result.label}</span>
                  <small>{coordinateLabel(result.latitude, result.longitude)}</small>
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="local-privacy-note">
          위치는 계정이나 서버에 저장하지 않으며, 이 예보 요청에만 사용합니다.
        </p>
      </div>
    </section>
  );
}

function PerformanceEvidence({ performance }: Pick<LocalForecastResponse, "performance">) {
  const { status, reason, station, profile } = performance;
  const active = status === "active";
  const providerRows = profile?.providers ?? [];
  const eligibleRows = providerRows.filter((provider) => provider.eligible);
  const sampleCount = eligibleRows.length > 0
    ? Math.min(...eligibleRows.map((provider) => provider.windowSampleCount))
    : 0;

  return (
    <section className="local-evidence-section" aria-labelledby="evidence-heading">
      <div className="local-section-heading">
        <div>
          <p className="local-eyebrow">RECENT LOCAL PERFORMANCE</p>
          <h2 id="evidence-heading">최근 이 지역에서<br />누가 더 잘 맞았나</h2>
        </div>
        <span className={`local-status-pill is-${status}`}>
          {active ? "가중치 반영 중" : status === "collecting" ? "근거 수집 중" : "근거 준비 중"}
        </span>
      </div>

      <div className="local-evidence-meta">
        <div>
          <span>비교 관측소</span>
          <strong>{station ? `${station.name} · ${station.distanceKm.toFixed(1)}km` : "아직 연결되지 않음"}</strong>
        </div>
        <div>
          <span>운영 기준</span>
          <strong>최근 30일 · 반감기 14일</strong>
        </div>
        <div>
          <span>비교 표본</span>
          <strong>{sampleCount > 0 ? `${sampleCount}회 / 코호트` : "수집 전"}</strong>
        </div>
      </div>

      {profile && providerRows.length > 0 ? (
        <div className="local-score-table" role="table" aria-label="서비스별 최근 강수 예보 성능">
          <div className="local-score-row local-score-header" role="row">
            <span role="columnheader">서비스</span>
            <span role="columnheader">최근 7일 Brier</span>
            <span role="columnheader">30일 Brier</span>
            <span role="columnheader">빗나감</span>
          </div>
          {providerRows.map((provider) => (
            <div className="local-score-row" role="row" key={provider.provider}>
              <strong role="cell">{PROVIDER_SHORT_NAMES[provider.provider] ?? provider.provider}</strong>
              <span role="cell">{provider.last7Days.brierScore?.toFixed(3) ?? "—"}</span>
              <span role="cell">{provider.brierScore.toFixed(3)}</span>
              <span role="cell">누락 {provider.misses} · 오보 {provider.falseAlarms}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="local-empty-evidence">
          <strong>
            {reason === "database-not-configured"
              ? "지역 성능 데이터베이스를 연결하면 이곳에 실제 비교가 표시됩니다."
              : reason === "benchmark-regression"
                ? "적응형 예보가 동일 가중 기준보다 나빠져 가중치 반영을 잠시 멈췄습니다."
                : reason === "benchmark-insufficient"
                  ? "적응형 방식과 동일 가중 방식을 공정하게 비교할 표본이 더 필요합니다."
              : reason === "no-eligible-station"
                ? "이 위치를 대표할 만한 가까운 관측소가 아직 없습니다."
                : "충분한 예보와 관측이 쌓일 때까지 동일 가중치를 사용합니다."}
          </strong>
          <p>최소 30개의 비교 가능한 익일 예보와 비 온 날·안 온 날 근거가 모두 필요합니다.</p>
        </div>
      )}

      <p className="local-method-note">
        Brier 점수는 낮을수록 좋습니다. 06시와 18시 예보를 섞지 않고, 비가 오지 않은 날도
        모두 포함합니다. 최근 성능은 확률 예보의 영향만 조정하며 정확성을 보장하지 않습니다.
      </p>
    </section>
  );
}

function ForecastDashboard({ forecast, onReset }: {
  forecast: LocalForecastResponse;
  onReset(): void;
}) {
  const availableProviders = forecast.providers.filter((provider) => provider.available);
  const probability = forecast.recommendation.precipitationProbability;
  const sourceMode = forecast.performance.status === "active"
    ? "최근 관측 성능 반영"
    : "동일 가중 평균";
  const sortedInfluence = useMemo(
    () => Object.entries(forecast.providerInfluence).sort((a, b) => b[1] - a[1]),
    [forecast.providerInfluence],
  );

  return (
    <main className="local-dashboard">
      <div className="local-dashboard-topline">
        <div>
          <span>{forecast.location.name}</span>
          <small>{coordinateLabel(forecast.location.latitude, forecast.location.longitude)}</small>
        </div>
        <button type="button" onClick={onReset}>위치 바꾸기</button>
      </div>

      <section className="local-forecast-hero" aria-labelledby="tomorrow-heading">
        <div className="local-forecast-intro">
          <p className="local-eyebrow">{formatDate(forecast.targetDate)} · TOMORROW</p>
          <h1 id="tomorrow-heading">내일 비 올 확률</h1>
          <p className="local-action-copy">
            {rainAction(probability, forecast.recommendation.precipitationAmountMm)}
          </p>
        </div>

        <div className="local-rain-number" aria-label={`강수 확률 ${probabilityLabel(probability)}`}>
          <span>{probability === null ? "—" : Math.round(probability)}</span>
          {probability !== null && <small>%</small>}
        </div>

        <div className="local-forecast-facts">
          <div><span>예상 강수량</span><strong>{forecast.recommendation.precipitationAmountMm === null ? "—" : `${forecast.recommendation.precipitationAmountMm.toFixed(1)} mm`}</strong></div>
          <div><span>낮 / 밤</span><strong>{forecast.recommendation.temperatureMax === null ? "—" : `${Math.round(forecast.recommendation.temperatureMax)}°`} / {forecast.recommendation.temperatureMin === null ? "—" : `${Math.round(forecast.recommendation.temperatureMin)}°`}</strong></div>
          <div><span>계산 방식</span><strong>{sourceMode}</strong></div>
        </div>
      </section>

      {forecast.outlook.length > 1 && (
        <section className="local-outlook-section" aria-labelledby="outlook-heading">
          <div className="local-section-heading local-outlook-heading">
            <div>
              <p className="local-eyebrow">7 DAY OUTLOOK</p>
              <h2 id="outlook-heading">그다음 날씨</h2>
            </div>
            <p>같은 가중 원칙으로 앞으로의 강수 확률을 나란히 봅니다.</p>
          </div>
          <div className="local-outlook-grid">
            {forecast.outlook.map((day) => (
              <div className="local-outlook-day" key={day.date}>
                <span>{formatOutlookDate(day.date)}</span>
                <strong>{probabilityLabel(day.precipitationProbability)}</strong>
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

      <section className="local-influence-section" aria-labelledby="influence-heading">
        <div className="local-section-heading">
          <div>
            <p className="local-eyebrow">PROVIDER INFLUENCE</p>
            <h2 id="influence-heading">이번 예보에<br />각 서비스가 미친 영향</h2>
          </div>
          <p>{availableProviders.length}개 서비스의 익일 강수 확률을 비교했습니다.</p>
        </div>

        <div className="local-influence-grid">
          {sortedInfluence.map(([provider, influence]) => {
            const detail = forecast.providers.find((candidate) => candidate.id === provider);
            return (
              <div className="local-influence-row" key={provider}>
                <div>
                  <strong>{PROVIDER_SHORT_NAMES[provider] ?? provider}</strong>
                  <span>{probabilityLabel(detail?.probability ?? null)}</span>
                </div>
                <div className="local-weight-track" aria-label={`${Math.round(influence * 100)}% 영향`}>
                  <span style={{ width: `${influence * 100}%` }} />
                </div>
                <b>{Math.round(influence * 100)}%</b>
              </div>
            );
          })}
        </div>

        {forecast.performance.profile?.benchmark && (
          <p className="local-benchmark-line">
            사전 고정 비교 · 적응형 Brier {forecast.performance.profile.benchmark.adaptiveBrier?.toFixed(3) ?? "—"}
            <span /> 동일 가중 {forecast.performance.profile.benchmark.equalBrier?.toFixed(3) ?? "—"}
          </p>
        )}
      </section>

      <PerformanceEvidence performance={forecast.performance} />

      <footer className="local-footer">
        <p>예보: Open-Meteo · MET Norway · 기상청 · Pirate Weather · WeatherAPI</p>
        <p>관측 검증: 기상청 ASOS · 사용자 위치는 저장하지 않음</p>
      </footer>
    </main>
  );
}

export default function LocalForecastExperience() {
  const [state, setState] = useState<ViewState>({ kind: "idle" });

  const chooseLocation = async (input: {
    name: string;
    latitude: number;
    longitude: number;
    elevationM: number | null;
  }) => {
    setState({ kind: "loading", label: input.name });
    try {
      setState({ kind: "ready", forecast: await loadForecast(input) });
    } catch {
      setState({ kind: "error", message: "이 위치의 예보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요." });
    }
  };

  return (
    <div className="local-forecast-page">
      <div className="local-atmosphere" aria-hidden><span /><span /><span /></div>
      <header className="local-site-header">
        <button type="button" onClick={() => setState({ kind: "idle" })} aria-label="처음으로">
          <span className="local-wordmark">SEOULSKY</span>
          <small>전국 로컬 예보</small>
        </button>
        <span className="local-live-mark"><i /> KST · LIVE SOURCES</span>
      </header>

      {state.kind === "idle" && <LocationChooser onChoose={(input) => void chooseLocation(input)} />}

      {state.kind === "loading" && (
        <div className="local-loading" role="status">
          <span />
          <p>{state.label}의 내일 예보를 비교하고 있어요.</p>
        </div>
      )}

      {state.kind === "error" && (
        <div className="local-loading" role="alert">
          <p>{state.message}</p>
          <button type="button" onClick={() => setState({ kind: "idle" })}>다른 위치 선택</button>
        </div>
      )}

      {state.kind === "ready" && (
        <ForecastDashboard forecast={state.forecast} onReset={() => setState({ kind: "idle" })} />
      )}
    </div>
  );
}
