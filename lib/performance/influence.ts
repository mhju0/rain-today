import {
  blendPrecipProbability,
  DEFAULT_PERFORMANCE_POLICY,
} from "./performance.ts";
import type { CapturedProviderForecast, RecentPerformanceProfile } from "./types.ts";

/**
 * One derivation of Effective Influence and the blend it produces.
 *
 * Influence was previously derived separately at capture time and at serving
 * time. The Prospective Benchmark scores a probability frozen by the capture
 * path against the blend served by the serving path, so those two must agree by
 * construction rather than by coincidence.
 */
export interface PrecipitationBlend {
  /** Effective Influence: normalized over the providers present in this call. */
  influence: Record<string, number>;
  probability: number | null;
  amountMm: number | null;
}

/**
 * Learned influence applies only while the profile is earning or holding it.
 * Every other mode — including a suspended benchmark — is Equal Fallback.
 */
function learnedWeights(
  profile: RecentPerformanceProfile | null,
): Readonly<Record<string, number>> | null {
  if (!profile) return null;
  return profile.mode === "learned" || profile.mode === "ramping"
    ? profile.effectiveWeights
    : null;
}

function equalInfluence(
  forecasts: readonly CapturedProviderForecast[],
): Record<string, number> {
  const share = forecasts.length > 0 ? 1 / forecasts.length : 0;
  return Object.fromEntries(forecasts.map((forecast) => [forecast.provider, share]));
}

function effectiveInfluence(
  forecasts: readonly CapturedProviderForecast[],
  profile: RecentPerformanceProfile | null,
): Record<string, number> {
  const learned = learnedWeights(profile);
  if (!learned) return equalInfluence(forecasts);
  // A provider the profile has no weight for — newly added, or dropped from the
  // metrics for want of comparable samples — falls back to the floor rather than
  // to an equal share. That is a demotion, and it is deliberate: an unscored
  // provider should not carry the same influence as a measured one.
  const raw = Object.fromEntries(
    forecasts.map((forecast) => [
      forecast.provider,
      Math.max(0, learned[forecast.provider] ?? DEFAULT_PERFORMANCE_POLICY.weightFloor),
    ]),
  );
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return equalInfluence(forecasts);
  return Object.fromEntries(
    Object.entries(raw).map(([provider, value]) => [provider, value / total]),
  );
}

function blendAmount(
  forecasts: readonly CapturedProviderForecast[],
  influence: Readonly<Record<string, number>>,
): number | null {
  const reporting = forecasts.filter((forecast) => forecast.amountMm !== null);
  const totalWeight = reporting.reduce(
    (sum, forecast) => sum + (influence[forecast.provider] ?? 0),
    0,
  );
  if (totalWeight <= 0) return null;
  return reporting.reduce(
    (sum, forecast) => sum + forecast.amountMm! * (influence[forecast.provider] ?? 0) / totalWeight,
    0,
  );
}

/**
 * Blend one set of provider forecasts under a Recent Performance Profile.
 *
 * Pass `null` for the profile to get the Equal Fallback blend — the same call
 * the capture path uses for its prospective equal-weight benchmark.
 */
export function blendPrecipitation(
  forecasts: readonly CapturedProviderForecast[],
  profile: RecentPerformanceProfile | null,
): PrecipitationBlend {
  const influence = effectiveInfluence(forecasts, profile);
  return {
    influence,
    probability: blendPrecipProbability(forecasts, influence),
    amountMm: blendAmount(forecasts, influence),
  };
}
