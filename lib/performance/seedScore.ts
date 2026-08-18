import { scoreSourceDay } from "../reliability/score.ts";
import { normalizeClamped } from "./performance.ts";
import type {
  PerformancePolicy,
  PrecipProviderId,
  SeedComparison,
  SeedProviderPerformance,
} from "./types.ts";

/**
 * Scoring for retrospective Seed Comparisons.
 *
 * Live evidence is scored on the probability Brier score. Seed evidence cannot
 * be: public archives publish an amount but no probability. Rather than invent a
 * probability, seed evidence is scored on the amount-and-outcome skill that
 * `lib/reliability/score.ts` already defines and unit-tests — rain/no-rain with
 * an asymmetric miss penalty, plus an amount term on days it actually rained.
 *
 * Two rules keep the seed from overstating itself:
 *
 * 1. Capped influence. Seed weights are blended toward equal at SEED_INFLUENCE,
 *    never applied at full strength, because they rest on model proxies rather
 *    than on the providers' own published forecasts.
 * 2. No opinion is not a penalty. A provider absent from the seed (or not yet
 *    mature in it) is scored at the neutral mean, so it lands near equal instead
 *    of being demoted for having no archive proxy.
 */

/**
 * How far seed weights may move away from equal. Retrospective, proxy-derived,
 * and covering only the providers with an honest archive — so it is deliberately
 * partial influence, and live evidence supersedes it entirely once mature.
 */
export const SEED_INFLUENCE = 0.5;

interface SeedProfileInput {
  comparisons: readonly SeedComparison[];
  /** Providers being blended at serving time; may exceed the seeded providers. */
  providers: readonly PrecipProviderId[];
  policy: PerformancePolicy;
}

export interface SeedProfile {
  /** Per-provider retrospective performance, sorted by provider id. */
  providers: SeedProviderPerformance[];
  /** True when at least two providers carry mature, balanced seed evidence. */
  ready: boolean;
  /** Bounded seed weights over `providers`, before the influence blend. */
  weights: Record<string, number>;
}

function equalWeights(providers: readonly string[]): Record<string, number> {
  const value = providers.length === 0 ? 0 : 1 / providers.length;
  return Object.fromEntries(providers.map((provider) => [provider, value]));
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Score one provider's whole seed history. Returns null when it never appears. */
export function seedProviderPerformance(
  provider: PrecipProviderId,
  comparisons: readonly SeedComparison[],
  policy: PerformancePolicy,
): SeedProviderPerformance | null {
  const rows = comparisons.flatMap((comparison) => {
    const forecast = comparison.providers.find((entry) => entry.provider === provider);
    if (!forecast || forecast.amountMm === null || !Number.isFinite(forecast.amountMm)) return [];
    return [{ amountMm: forecast.amountMm, observedMm: comparison.observedMm }];
  });
  if (rows.length === 0) return null;

  const skills: number[] = [];
  let misses = 0;
  let falseAlarms = 0;
  let wetDays = 0;
  for (const row of rows) {
    if (row.observedMm >= policy.rainThresholdMm) wetDays += 1;
    // Archives publish no probability, so the amount is the only rain signal.
    const score = scoreSourceDay({
      pop: null,
      predicted_mm: row.amountMm,
      observed_mm: row.observedMm,
    });
    if (score === null) continue; // correct-dry carries no precipitation skill
    skills.push(score.skill);
    if (score.outcome === "miss") misses += 1;
    if (score.outcome === "false_alarm") falseAlarms += 1;
  }

  const dryDays = rows.length - wetDays;
  return {
    provider,
    sampleCount: rows.length,
    scoredCount: skills.length,
    wetDays,
    dryDays,
    misses,
    falseAlarms,
    meanSkill: mean(skills),
    eligible:
      rows.length >= policy.minimumSamples && wetDays > 0 && dryDays > 0 && skills.length > 0,
  };
}

/**
 * Build the seed profile for one station. `weights` are bounded by the same
 * floor/cap projection the live path uses, so both pipelines obey one rule.
 */
export function buildSeedProfile(input: SeedProfileInput): SeedProfile {
  const scored = input.providers.flatMap((provider) => {
    const performance = seedProviderPerformance(provider, input.comparisons, input.policy);
    return performance ? [performance] : [];
  });
  const eligible = scored.filter((performance) => performance.eligible);
  const equal = equalWeights(input.providers);
  if (eligible.length < 2) {
    return { providers: scored, ready: false, weights: equal };
  }

  const rawOf = (performance: SeedProviderPerformance): number =>
    Math.exp(input.policy.scoreSharpness * (performance.meanSkill ?? 0));
  const neutral = mean(eligible.map(rawOf))!;
  const byProvider = new Map(eligible.map((performance) => [performance.provider, performance]));
  const raw = Object.fromEntries(
    input.providers.map((provider) => {
      const performance = byProvider.get(provider);
      // A provider with no mature seed evidence has no opinion, not a bad one.
      return [provider, performance ? rawOf(performance) : neutral];
    }),
  );

  return {
    providers: scored,
    ready: true,
    weights: normalizeClamped(raw, input.policy.weightFloor, input.policy.weightCap),
  };
}

/**
 * Blend seed weights toward equal at SEED_INFLUENCE. Both inputs sum to 1, so
 * the result does too.
 */
export function seedEffectiveWeights(
  seedWeights: Readonly<Record<string, number>>,
  providers: readonly PrecipProviderId[],
  influence: number = SEED_INFLUENCE,
): Record<string, number> {
  const equal = equalWeights(providers);
  return Object.fromEntries(
    providers.map((provider) => [
      provider,
      equal[provider] + influence * ((seedWeights[provider] ?? equal[provider]) - equal[provider]),
    ]),
  );
}
