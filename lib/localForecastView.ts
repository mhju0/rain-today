import type { LocalForecastEvidence, LocalForecastResponse } from "./localForecast.ts";

/**
 * The wire contract for the local forecast page.
 *
 * `LocalForecastResponse` is the server's own shape: it embeds the whole
 * Recent Performance Profile, so a client reading it navigates four levels into
 * a domain module it never imports, and has to re-express server enums as
 * display copy. This view is flat on purpose — the client reads fields.
 */

export interface LocalForecastProviderInfluence {
  id: string;
  name: string;
  probability: number | null;
  /** Effective Influence, already sorted from most to least influential. */
  influence: number;
}

export interface LocalForecastProviderScore {
  id: string;
  name: string;
  last7DaysBrier: number | null;
  windowBrier: number;
  misses: number;
  falseAlarms: number;
  rainyAmountMae: number | null;
  rainyAmountSampleCount: number;
}

export interface LocalForecastEvidenceView {
  status: LocalForecastEvidence["status"];
  statusLabel: string;
  /** Null when no Station Match backs this forecast yet. */
  station: { name: string; distanceKm: number } | null;
  comparisonSampleCount: number;
  /** Present only when there is nothing to score yet; already resolved copy. */
  emptyMessage: string | null;
  scores: LocalForecastProviderScore[];
  benchmark: { adaptiveBrier: number | null; equalBrier: number | null } | null;
}

export interface LocalForecastView {
  generatedAt: string;
  locationName: string;
  targetDate: string | null;
  recommendation: LocalForecastResponse["recommendation"];
  outlook: LocalForecastResponse["outlook"];
  /** Whether learned influence is being applied, in one word for the client. */
  blendMode: "learned" | "equal";
  comparedProviderCount: number;
  influence: LocalForecastProviderInfluence[];
  evidence: LocalForecastEvidenceView;
}

/**
 * Copy for every reason the evidence can be missing. Exhaustive by construction:
 * adding a reason without adding copy fails to compile, rather than silently
 * falling through to the "still collecting" message — which would tell a user
 * that evidence is accumulating while the database is actually unreachable.
 */
const EMPTY_EVIDENCE_COPY: Record<LocalForecastEvidence["reason"], string> = {
  "eligible-station": "이 지역의 비교 근거를 준비하고 있습니다.",
  "insufficient-evidence": "충분한 예보와 관측이 쌓일 때까지 동일 가중치를 사용합니다.",
  "benchmark-insufficient": "적응형 방식과 동일 가중 방식을 공정하게 비교할 표본이 더 필요합니다.",
  "benchmark-regression": "적응형 예보가 동일 가중 기준보다 나빠져 가중치 반영을 잠시 멈췄습니다.",
  "no-eligible-station": "이 위치를 대표할 만한 가까운 관측소가 아직 없습니다.",
  "database-not-configured": "지역 성능 데이터베이스를 연결하면 이곳에 실제 비교가 표시됩니다.",
  "database-unavailable": "지역 성능 근거를 지금 불러오지 못해 동일 가중치로 예보했습니다.",
};

/**
 * Compact display names for the influence bars and score table, where the full
 * provider status name ("기상청 단기예보 (KMA)") does not fit. Owned here so the
 * client carries no provider list of its own; unknown ids fall back to the name
 * the response already supplies.
 */
const PROVIDER_SHORT_NAMES: Readonly<Record<string, string>> = {
  "open-meteo": "Open-Meteo",
  "met-norway": "MET Norway",
  kma: "기상청",
  "pirate-weather": "Pirate Weather",
  "weather-api": "WeatherAPI",
};

const STATUS_LABELS: Record<LocalForecastEvidence["status"], string> = {
  active: "가중치 반영 중",
  collecting: "근거 수집 중",
  unavailable: "근거 준비 중",
};

/** Project the server response onto the flat contract the page renders. */
export function toLocalForecastView(response: LocalForecastResponse): LocalForecastView {
  const displayName = (id: string): string =>
    PROVIDER_SHORT_NAMES[id] ??
    response.providers.find((provider) => provider.id === id)?.name ??
    id;
  const probabilities = new Map(
    response.providers.map((provider) => [provider.id as string, provider.probability]),
  );
  const profile = response.performance.profile;
  const scoreRows = profile?.providers ?? [];

  return {
    generatedAt: response.generatedAt,
    locationName: response.location.name,
    targetDate: response.targetDate,
    recommendation: response.recommendation,
    outlook: response.outlook,
    blendMode: response.performance.status === "active" ? "learned" : "equal",
    comparedProviderCount: response.providers.filter((provider) => provider.available).length,
    influence: Object.entries(response.effectiveInfluence)
      .sort((a, b) => b[1] - a[1])
      .map(([id, influence]) => ({
        id,
        name: displayName(id),
        probability: probabilities.get(id) ?? null,
        influence,
      })),
    evidence: {
      status: response.performance.status,
      statusLabel: STATUS_LABELS[response.performance.status],
      station: response.performance.station
        ? {
            name: response.performance.station.name,
            distanceKm: response.performance.station.distanceKm,
          }
        : null,
      // The comparison count a user is shown is the weakest provider's, so the
      // claim holds for every row in the table rather than the best one.
      comparisonSampleCount: scoreRows.length > 0
        ? Math.min(...scoreRows.map((provider) => provider.windowSampleCount))
        : 0,
      emptyMessage: scoreRows.length > 0
        ? null
        : EMPTY_EVIDENCE_COPY[response.performance.reason],
      scores: scoreRows.map((provider) => ({
        id: provider.provider,
        name: displayName(provider.provider),
        last7DaysBrier: provider.last7Days.brierScore,
        windowBrier: provider.brierScore,
        misses: provider.misses,
        falseAlarms: provider.falseAlarms,
        rainyAmountMae: provider.rainyAmountMae,
        rainyAmountSampleCount: provider.rainyAmountSampleCount,
      })),
      benchmark: profile
        ? {
            adaptiveBrier: profile.prospectiveBenchmark.adaptiveBrier,
            equalBrier: profile.prospectiveBenchmark.equalBrier,
          }
        : null,
    },
  };
}
