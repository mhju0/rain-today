import { buildForecastBlocks } from "./forecast/blocks.ts";
import { readTimeline, type TimelineReading } from "./forecast/rainWindow.ts";
import type { LocalForecastEvidence, LocalForecastResponse } from "./localForecast.ts";
import type { WeatherCondition } from "./types.ts";

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
  /** Days scored in the window, so "빗나간 날" can be shown over its total. */
  windowSampleCount: number;
  misses: number;
  falseAlarms: number;
  rainyAmountMae: number | null;
  rainyAmountSampleCount: number;
}

/**
 * One provider's retrospective record, shown while seed evidence is driving the
 * blend. Carries no Brier score: archives publish no probability to score one from.
 */
export interface LocalForecastSeedScore {
  id: string;
  name: string;
  /** Days it actually rained, and how many of those the provider called dry. */
  wetDays: number;
  misses: number;
  falseAlarms: number;
  sampleCount: number;
}

export interface LocalForecastEvidenceView {
  status: LocalForecastEvidence["status"];
  statusLabel: string;
  /** Null when no Station Match backs this forecast yet. */
  station: { name: string; distanceKm: number } | null;
  comparisonSampleCount: number;
  /** Present only when there is nothing to score yet; already resolved copy. */
  emptyMessage: string | null;
  /** Second line for `emptyMessage`, only where one is actually true. */
  emptyDetail: string | null;
  scores: LocalForecastProviderScore[];
  /** Populated only in seed mode, where `scores` has nothing to show. */
  seedScores: LocalForecastSeedScore[];
  benchmark: { adaptiveBrier: number | null; equalBrier: number | null } | null;
}

/**
 * The probability at which this page first tells someone to carry an umbrella.
 * Held in step with the 40% band in the hero's advice copy so the timeline
 * cannot mark rain beginning in a block the advice still calls dry.
 */
const RAIN_ONSET_PROBABILITY = 40;

export interface LocalForecastTimelineBlock {
  /** "지금" for the block covering now, otherwise its Korean period name. */
  label: string;
  /** Short KST range, e.g. "15–18시". */
  rangeLabel: string;
  /** KST hour the block opens on — the ribbon's axis ticks. */
  startHour: number;
  /** Exclusive KST hour the block closes on. */
  endHour: number;
  /** Highest probability in the block. Null — never 0 — when no hour carries one. */
  precipMax: number | null;
  condition: WeatherCondition;
  /** At or above the umbrella threshold, so the ribbon marks it as rain. */
  wet: boolean;
  /** "8/19 (수)" on the first block of a new KST date; null elsewhere. */
  dayTag: string | null;
}

export interface LocalForecastTimelineView {
  blocks: LocalForecastTimelineBlock[];
  /**
   * Whose series this is. These blocks come from one provider, while the
   * headline probability is a blend of several, so the page has to attribute
   * them rather than let them read as consensus.
   */
  sourceName: string;
  /** The probability at which the ribbon starts calling a block rain. */
  threshold: number;
  /** Start and end of the rain, already derived — the page only formats it. */
  reading: TimelineReading;
}

export interface LocalForecastView {
  generatedAt: string;
  locationName: string;
  targetDate: string | null;
  current: LocalForecastResponse["current"];
  /** Today's forecast, always equal-weighted. Null when nobody still publishes it. */
  today: LocalForecastResponse["today"];
  /** Which daily release this forecast belongs to, already in display form. */
  cohortLabel: string;
  recommendation: LocalForecastResponse["recommendation"];
  outlook: LocalForecastResponse["outlook"];
  /** Which evidence is driving influence, in one word for the client. `seed` is
   *  retrospective archive evidence at capped influence, not measured local skill. */
  blendMode: "learned" | "equal" | "seed";
  comparedProviderCount: number;
  /** Time-of-day precipitation shape for the hero. Null when no provider publishes hourly. */
  timeline: LocalForecastTimelineView | null;
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
  // Seed evidence IS being applied, so this must not read like a "still waiting"
  // message. It says where the estimate came from and that it is provisional.
  "seed-evidence": "이 지역의 실시간 비교가 쌓이기 전이라, 과거 예보 기록으로 추정한 적중률을 일부만 반영했습니다.",
  "no-eligible-station": "이 위치를 대표할 만한 가까운 관측소가 아직 없습니다.",
  // Addressed to the visitor, not the operator. "Connect the database" told a
  // member of the public to perform an action only the operator can take.
  "database-not-configured": "이 지역의 최근 성능 기록이 아직 없어, 서비스를 똑같은 비중으로 평균했습니다.",
  "database-unavailable": "지역 성능 근거를 지금 불러오지 못해 동일 가중치로 예보했습니다.",
};

/**
 * The sample-size explanation is only true for the two reasons that are
 * actually about sample size. Stapling it under "no nearby station" told a user
 * on Jeju to wait for evidence that will never accumulate there.
 */
const EMPTY_EVIDENCE_DETAIL: Partial<Record<LocalForecastEvidence["reason"], string>> = {
  "insufficient-evidence": "최소 30개의 비교 가능한 익일 예보와 비 온 날·안 온 날 근거가 모두 필요합니다.",
  "benchmark-insufficient": "최소 30개의 비교 가능한 익일 예보와 비 온 날·안 온 날 근거가 모두 필요합니다.",
  "no-eligible-station": "가까운 관측소가 생기면 이 지역의 비교가 시작됩니다.",
  "benchmark-regression": "다시 나아지면 자동으로 가중치 반영으로 돌아갑니다.",
  "seed-evidence": "이 지역에서 실제 비교가 쌓이면 과거 추정을 대체합니다.",
};

/** "8/19 (수)" — the divider label where the ribbon crosses into a new KST day. */
function formatDayTag(date: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${date}T12:00:00+09:00`));
}

const COHORT_LABELS: Record<LocalForecastResponse["captureCohort"], string> = {
  "06": "오전 6시 발표 기준",
  "18": "오후 6시 발표 기준",
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
  // Only shown while the seed is actually driving the blend; once live evidence
  // matures the seed is superseded and must not linger beside it as if current.
  const seedRows = response.performance.reason === "seed-evidence"
    ? (profile?.seed ?? []).filter((provider) => provider.eligible)
    : [];
  // buildForecastBlocks folds the "now"-anchored series into up to eight 3-hour
  // blocks and leaves precipMax null where no hour carried a probability, so a
  // gap in the series stays a gap here rather than becoming a confident 0%.
  const blocks = response.hourly ? buildForecastBlocks(response.hourly.entries) : [];
  const timeline: LocalForecastTimelineView | null =
    response.hourly && blocks.length > 0
      ? {
          blocks: blocks.map((block, index) => ({
            label: block.label,
            rangeLabel: block.rangeLabel,
            startHour: block.startHour,
            endHour: block.endHour,
            precipMax: block.precipMax,
            condition: block.condition,
            wet: block.precipMax !== null && block.precipMax >= RAIN_ONSET_PROBABILITY,
            // Tag only where the KST date actually turns over, so the ribbon
            // draws one divider rather than repeating the date on every block.
            dayTag:
              index > 0 && block.startDate !== blocks[index - 1].startDate
                ? formatDayTag(block.startDate)
                : null,
          })),
          sourceName: response.hourly.sourceName,
          threshold: RAIN_ONSET_PROBABILITY,
          reading: readTimeline(blocks, RAIN_ONSET_PROBABILITY),
        }
      : null;

  return {
    generatedAt: response.generatedAt,
    locationName: response.location.name,
    targetDate: response.targetDate,
    current: response.current,
    today: response.today,
    cohortLabel: COHORT_LABELS[response.captureCohort],
    recommendation: response.recommendation,
    outlook: response.outlook,
    blendMode:
      response.performance.reason === "seed-evidence"
        ? "seed"
        : response.performance.status === "active"
          ? "learned"
          : "equal",
    comparedProviderCount: response.providers.filter((provider) => provider.available).length,
    timeline,
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
      seedScores: seedRows.map((provider) => ({
        id: provider.provider,
        name: displayName(provider.provider),
        wetDays: provider.wetDays,
        misses: provider.misses,
        falseAlarms: provider.falseAlarms,
        sampleCount: provider.sampleCount,
      })),
      // Seed rows are evidence too: showing the "still collecting" copy over a
      // populated seed table would deny the numbers printed right beside it.
      emptyMessage: scoreRows.length > 0 || seedRows.length > 0
        ? null
        : EMPTY_EVIDENCE_COPY[response.performance.reason],
      emptyDetail: scoreRows.length > 0 || seedRows.length > 0
        ? null
        : EMPTY_EVIDENCE_DETAIL[response.performance.reason] ?? null,
      scores: scoreRows.map((provider) => ({
        id: provider.provider,
        name: displayName(provider.provider),
        last7DaysBrier: provider.last7Days.brierScore,
        windowBrier: provider.brierScore,
        windowSampleCount: provider.windowSampleCount,
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
