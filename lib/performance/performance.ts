import type {
  CapturedProviderForecast,
  ForecastCapture,
  LocalPerformanceProfile,
  PerformanceBenchmark,
  PerformancePolicy,
  PrecipObservation,
  PrecipProviderId,
  ProviderRecentPerformance,
} from "./types.ts";

export const DEFAULT_PERFORMANCE_POLICY: PerformancePolicy = {
  windowDays: 30,
  halfLifeDays: 14,
  reportDays: 7,
  minimumSamples: 30,
  fullInfluenceSamples: 60,
  rainThresholdMm: 0.1,
  decisionThreshold: 50,
  weightFloor: 0.05,
  weightCap: 0.6,
  scoreSharpness: 4,
};

interface CompletedCapture {
  capture: ForecastCapture;
  observation: PrecipObservation;
  ageDays: number;
  recencyWeight: number;
}

interface ProviderScoreRow {
  ageDays: number;
  recencyWeight: number;
  probability: number;
  amountMm: number | null;
  observedMm: number;
  wet: boolean;
}

interface ProfileInput {
  stationId: string;
  cohort: ForecastCapture["cohort"];
  captures: readonly ForecastCapture[];
  observations: readonly PrecipObservation[];
  asOf: Date;
  policy?: PerformancePolicy;
}

function koreanDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function dateAtUtcMidnight(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

function calendarAgeDays(asOfDate: string, targetDate: string): number {
  return Math.round((dateAtUtcMidnight(asOfDate) - dateAtUtcMidnight(targetDate)) / 86_400_000);
}

function subtractCalendarDays(date: string, days: number): string {
  return new Date(dateAtUtcMidnight(date) - days * 86_400_000).toISOString().slice(0, 10);
}

function validProbability(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 100;
}

function brier(probability: number, wet: boolean): number {
  return (probability / 100 - (wet ? 1 : 0)) ** 2;
}

function weightedMean(rows: readonly { value: number; weight: number }[]): number | null {
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  if (totalWeight <= 0) return null;
  return rows.reduce((sum, row) => sum + row.value * row.weight, 0) / totalWeight;
}

function round(value: number | null, places = 4): number | null {
  if (value === null) return null;
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function equalWeights(providers: readonly PrecipProviderId[]): Record<string, number> {
  const value = providers.length === 0 ? 0 : 1 / providers.length;
  return Object.fromEntries(providers.map((provider) => [provider, value]));
}

function renormalize(weights: Record<string, number>): Record<string, number> {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0) return equalWeights(entries.map(([provider]) => provider as PrecipProviderId));
  return Object.fromEntries(entries.map(([provider, value]) => [provider, value / total]));
}

function normalizeClamped(
  raw: Record<string, number>,
  floor: number,
  cap: number,
): Record<string, number> {
  const providers = Object.keys(raw);
  if (providers.length <= 1 || floor * providers.length > 1 || cap * providers.length < 1) {
    return equalWeights(providers as PrecipProviderId[]);
  }
  const weights = Object.fromEntries(providers.map((provider) => [provider, floor]));
  const active = new Set(providers);
  let remaining = 1 - floor * providers.length;
  while (active.size > 0 && remaining > 1e-12) {
    const rawTotal = Array.from(active).reduce(
      (sum, provider) => sum + Math.max(0, raw[provider]),
      0,
    );
    const denominator = rawTotal > 0 ? rawTotal : active.size;
    const capped = Array.from(active).filter((provider) => {
      const share = rawTotal > 0 ? Math.max(0, raw[provider]) : 1;
      return remaining * share / denominator > cap - weights[provider];
    });
    if (capped.length === 0) {
      for (const provider of active) {
        const share = rawTotal > 0 ? Math.max(0, raw[provider]) : 1;
        weights[provider] += remaining * share / denominator;
      }
      remaining = 0;
      break;
    }
    for (const provider of capped) {
      remaining -= cap - weights[provider];
      weights[provider] = cap;
      active.delete(provider);
    }
  }
  return weights;
}

function completedCaptures(input: ProfileInput, policy: PerformancePolicy): CompletedCapture[] {
  const asOfDate = koreanDate(input.asOf);
  const observations = new Map(
    input.observations
      .filter((observation) => observation.stationId === input.stationId)
      .map((observation) => [observation.date, observation]),
  );

  return input.captures.flatMap((capture) => {
    if (capture.stationId !== input.stationId || capture.cohort !== input.cohort) return [];
    const observation = observations.get(capture.targetDate);
    if (!observation) return [];
    const ageDays = calendarAgeDays(asOfDate, capture.targetDate);
    if (ageDays < 0) return [];
    return [{
      capture,
      observation,
      ageDays,
      recencyWeight: Math.pow(0.5, ageDays / policy.halfLifeDays),
    }];
  });
}

function providerMetrics(
  provider: PrecipProviderId,
  completed: readonly CompletedCapture[],
  policy: PerformancePolicy,
): ProviderRecentPerformance | null {
  const rows: ProviderScoreRow[] = completed.flatMap((entry) => {
    const forecast = entry.capture.providers.find((candidate) => candidate.provider === provider);
    if (!forecast || !validProbability(forecast.probability)) return [];
    return [{
      ageDays: entry.ageDays,
      recencyWeight: entry.recencyWeight,
      probability: forecast.probability,
      amountMm:
        forecast.amountMm !== null && Number.isFinite(forecast.amountMm) && forecast.amountMm >= 0
          ? forecast.amountMm
          : null,
      observedMm: entry.observation.observedMm,
      wet: entry.observation.observedMm >= policy.rainThresholdMm,
    }];
  });
  if (rows.length === 0) return null;

  const windowRows = rows.filter((row) => row.ageDays <= policy.windowDays);
  if (windowRows.length === 0) return null;
  const wetRows = windowRows.filter((row) => row.wet);
  const dryRows = windowRows.filter((row) => !row.wet);
  const rainyAmountRows = wetRows.filter((row) => row.amountMm !== null);
  const brierScore = weightedMean(
    windowRows.map((row) => ({
      value: brier(row.probability, row.wet),
      weight: row.recencyWeight,
    })),
  )!;
  const last7Rows = rows.filter((row) => row.ageDays <= policy.reportDays);
  const last7Brier = weightedMean(
    last7Rows.map((row) => ({ value: brier(row.probability, row.wet), weight: 1 })),
  );

  return {
    provider,
    sampleCount: rows.length,
    windowSampleCount: windowRows.length,
    wetDays: wetRows.length,
    dryDays: dryRows.length,
    misses: wetRows.filter((row) => row.probability < policy.decisionThreshold).length,
    falseAlarms: dryRows.filter((row) => row.probability >= policy.decisionThreshold).length,
    brierScore: round(brierScore)!,
    rainyAmountSampleCount: rainyAmountRows.length,
    rainyAmountMae: round(
      rainyAmountRows.length === 0
        ? null
        : rainyAmountRows.reduce(
            (sum, row) => sum + Math.abs(row.amountMm! - row.observedMm),
            0,
          ) / rainyAmountRows.length,
      2,
    ),
    last7Days: {
      sampleCount: last7Rows.length,
      brierScore: round(last7Brier),
    },
    eligible:
      rows.length >= policy.minimumSamples && wetRows.length > 0 && dryRows.length > 0,
  };
}

function benchmark(
  completed: readonly CompletedCapture[],
  policy: PerformancePolicy,
): PerformanceBenchmark {
  const window = completed.filter((entry) => entry.ageDays <= policy.windowDays);
  const comparable = window.filter(
    (entry) =>
      validProbability(entry.capture.frozenBlend.adaptiveProbability) &&
      validProbability(entry.capture.frozenBlend.equalProbability),
  );
  const score = (probabilityOf: (entry: CompletedCapture) => number | null): number | null => {
    const rows = comparable.flatMap((entry) => {
      const probability = probabilityOf(entry);
      if (!validProbability(probability)) return [];
      return [{
        value: brier(
          probability,
          entry.observation.observedMm >= policy.rainThresholdMm,
        ),
        weight: entry.recencyWeight,
      }];
    });
    return weightedMean(rows);
  };
  const providerProbability =
    (provider: PrecipProviderId) =>
    (entry: CompletedCapture): number | null =>
      entry.capture.providers.find((candidate) => candidate.provider === provider)?.probability ?? null;
  const adaptive = score((entry) => entry.capture.frozenBlend.adaptiveProbability);
  const equal = score((entry) => entry.capture.frozenBlend.equalProbability);
  let status: PerformanceBenchmark["status"] = "insufficient";
  if (comparable.length >= policy.minimumSamples && adaptive !== null && equal !== null) {
    status = adaptive <= equal + 1e-12 ? "passing" : "regression";
  }

  return {
    sampleCount: comparable.length,
    adaptiveBrier: round(adaptive),
    equalBrier: round(equal),
    openMeteoBrier: round(score(providerProbability("open-meteo"))),
    kmaBrier: round(score(providerProbability("kma"))),
    status,
  };
}

/**
 * Build one auditable recent-performance profile for a station and capture cohort.
 * Callers need not know scoring, recency, evidence, bounding, or benchmark rules.
 */
export function buildLocalPerformanceProfile(input: ProfileInput): LocalPerformanceProfile {
  const policy = input.policy ?? DEFAULT_PERFORMANCE_POLICY;
  const completed = completedCaptures(input, policy);
  const providerIds = Array.from(
    new Set(
      completed.flatMap((entry) => entry.capture.providers.map((forecast) => forecast.provider)),
    ),
  ).sort();
  const providers = providerIds.flatMap((provider) => {
    const metrics = providerMetrics(provider, completed, policy);
    return metrics ? [metrics] : [];
  });
  const equal = equalWeights(providers.map((provider) => provider.provider));
  const eligible = providers.filter((provider) => provider.eligible);
  const evidenceReady = eligible.length >= 2;
  const currentBenchmark = benchmark(completed, policy);
  const minimumEvidence = evidenceReady
    ? Math.min(...eligible.map((provider) => provider.sampleCount))
    : 0;
  const confidence = evidenceReady
    ? Math.min(
        1,
        Math.max(
          0,
          (minimumEvidence - policy.minimumSamples) /
            (policy.fullInfluenceSamples - policy.minimumSamples),
        ),
      )
    : 0;
  const learned = normalizeClamped(
    Object.fromEntries(
      providers.map((provider) => [
        provider.provider,
        provider.eligible
          ? Math.exp(-policy.scoreSharpness * provider.brierScore)
          : policy.weightFloor,
      ]),
    ),
    policy.weightFloor,
    policy.weightCap,
  );

  let mode: LocalPerformanceProfile["mode"] = "equal-fallback";
  let reason: LocalPerformanceProfile["reason"] = "insufficient-evidence";
  let effectiveWeights = equal;
  if (evidenceReady && currentBenchmark.status === "insufficient") {
    mode = "suspended";
    reason = "benchmark-insufficient";
  } else if (evidenceReady && currentBenchmark.status === "regression") {
    mode = "suspended";
    reason = "benchmark-regression";
  } else if (evidenceReady) {
    mode = confidence < 1 ? "ramping" : "learned";
    reason = confidence < 1 ? "ramping" : "learned";
    effectiveWeights = renormalize(
      Object.fromEntries(
        providers.map((provider) => [
          provider.provider,
          equal[provider.provider] +
            confidence * (learned[provider.provider] - equal[provider.provider]),
        ]),
      ),
    );
  }

  const asOfDate = koreanDate(input.asOf);
  return {
    stationId: input.stationId,
    cohort: input.cohort,
    generatedAt: input.asOf.toISOString(),
    windowStart: subtractCalendarDays(asOfDate, policy.windowDays),
    windowEnd: asOfDate,
    mode,
    reason,
    confidence,
    providers,
    effectiveWeights,
    benchmark: currentBenchmark,
  };
}

/** Blend only the provider probabilities present at serving time. */
export function blendPrecipProbability(
  forecasts: readonly CapturedProviderForecast[],
  weights: Readonly<Record<string, number>>,
): number | null {
  const available = forecasts.filter((forecast) => validProbability(forecast.probability));
  const totalWeight = available.reduce(
    (sum, forecast) => sum + Math.max(0, weights[forecast.provider] ?? 0),
    0,
  );
  if (totalWeight <= 0) {
    if (available.length === 0) return null;
    return available.reduce((sum, forecast) => sum + forecast.probability!, 0) / available.length;
  }
  return available.reduce(
    (sum, forecast) =>
      sum + forecast.probability! * Math.max(0, weights[forecast.provider] ?? 0) / totalWeight,
    0,
  );
}
