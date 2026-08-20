import type {
  CurrentWeather,
  DailyForecast,
  HourlyForecast,
  ProviderId,
  WeatherCondition,
} from "./types";

/**
 * Deterministic current-conditions fusion for the public scene. Documented,
 * purpose-based precedence (not blind averaging) — unit-tested in
 * skyFusion.test.ts.
 *
 * Rules:
 *  • temperature  — fresh KMA observation when configured, else Open-Meteo
 *  • precipitation — KMA observation (authoritative for "is it raining now"),
 *                    else Open-Meteo
 *  • condition    — KMA when it reports ACTIVE precipitation (ground truth);
 *                   otherwise Open-Meteo, whose cloud-derived reading is richer
 *                   (KMA 초단기실황 has no sky/cloud category)
 *
 * Cloud cover, visibility, wind, is-day and the sky parameters always come from
 * Open-Meteo (the cinematic-sky primary); they are merged by the caller.
 */

const PRECIP_CONDITIONS: WeatherCondition[] = ["rain", "heavy-rain", "snow", "sleet", "drizzle"];

export function isPrecip(c: WeatherCondition): boolean {
  return PRECIP_CONDITIONS.includes(c);
}

export interface CurrentChoice {
  temperature: number;
  condition: WeatherCondition;
  precipitation: number;
  temperatureSource: ProviderId;
  conditionSource: ProviderId;
}

export function chooseCurrent(
  om: { temperature: number; condition: WeatherCondition; precipitation: number },
  kma: CurrentWeather | null,
): CurrentChoice {
  if (!kma) {
    return {
      temperature: om.temperature,
      condition: om.condition,
      precipitation: om.precipitation,
      temperatureSource: "open-meteo",
      conditionSource: "open-meteo",
    };
  }
  const kmaPrecip = isPrecip(kma.condition);
  return {
    temperature: kma.temperature,
    // KMA confirms active precip → trust it; otherwise keep Open-Meteo's cloud read.
    condition: kmaPrecip ? kma.condition : om.condition,
    precipitation: kma.precipitation ?? om.precipitation,
    temperatureSource: "kma",
    conditionSource: kmaPrecip ? "kma" : "open-meteo",
  };
}

// ── Phase 3: gated, PRECIP-ONLY learned-weight fusion ────────────────────────
// The functions below weight ONLY precipitation forecast fields (POP /
// predicted_mm). Temperature and every non-precip field are fused exactly as
// before. chooseCurrent (above) — the observation-based CURRENT conditions — is
// intentionally NOT weighted: the learned weights rank FORECAST skill, not the
// KMA observation, which is ground truth.

export interface PrecipContribution {
  source: ProviderId;
  pop: number | null;
  predicted_mm: number | null;
}

export interface FusedPrecip {
  pop: number | null;
  predicted_mm: number | null;
}

function weightedField(
  contributions: readonly PrecipContribution[],
  weights: Record<string, number>,
  select: (c: PrecipContribution) => number | null,
): number | null {
  let num = 0;
  let den = 0;
  for (const c of contributions) {
    const v = select(c);
    if (v === null) continue;
    const w = weights[c.source] ?? 0;
    if (w <= 0) continue;
    num += w * v;
    den += w;
  }
  return den > 0 ? num / den : null;
}

/**
 * Weighted precipitation consensus across forecast sources. Self-normalizes over
 * whichever sources actually contributed (a null field is skipped). A single
 * contributing source returns that source's value unchanged (the identity) — the
 * live `/api/sky` path supplies one forecast source, so this is byte-for-byte safe.
 */
export function fuseWeightedPrecip(
  contributions: readonly PrecipContribution[],
  weights: Record<string, number>,
): FusedPrecip {
  return {
    pop: weightedField(contributions, weights, (c) => c.pop),
    predicted_mm: weightedField(contributions, weights, (c) => c.predicted_mm),
  };
}

/**
 * Apply precip weights to the forecast POP / predicted_mm fields ONLY, leaving
 * every non-precip field (temperature, condition, wind, sun, …) untouched.
 * `source` is the single forecast source the live scene carries today
 * (Open-Meteo), so with one source this is the identity — i.e. byte-for-byte
 * unchanged vs pre-Phase-3. It begins to blend only once multiple forecast
 * sources are supplied as contributions.
 */
export function reweightForecastPrecip(
  input: {
    daily: DailyForecast[];
    hourly: HourlyForecast[];
    currentPrecipitationProbability: number | null;
  },
  source: ProviderId,
  weights: Record<string, number>,
): { daily: DailyForecast[]; hourly: HourlyForecast[]; currentPrecipitationProbability: number | null } {
  const daily = input.daily.map((d) => {
    const f = fuseWeightedPrecip(
      [{ source, pop: d.precipitationProbability, predicted_mm: d.precipitationAmount ?? null }],
      weights,
    );
    const out: DailyForecast = { ...d, precipitationProbability: f.pop };
    // Only rewrite predicted_mm when the source actually carried one — never add a
    // null amount where the field was absent (that would change the payload shape).
    if (d.precipitationAmount !== undefined) out.precipitationAmount = f.predicted_mm;
    return out;
  });
  const hourly = input.hourly.map((h) => {
    const f = fuseWeightedPrecip([{ source, pop: h.precipitationProbability, predicted_mm: null }], weights);
    return { ...h, precipitationProbability: f.pop };
  });
  const currentPrecipitationProbability = fuseWeightedPrecip(
    [{ source, pop: input.currentPrecipitationProbability, predicted_mm: null }],
    weights,
  ).pop;
  return { daily, hourly, currentPrecipitationProbability };
}

// ── Phase 4: multi-source weighted daily precip consensus ────────────────────
// Phase 3 carried a single forecast source, so the weighted consensus was the
// identity. Phase 4 feeds MULTIPLE forecast sources here by default so the
// learned weights have something to actually blend (MULTI_SOURCE_PRECIP=0 is the
// emergency opt-out). Still PRECIP-ONLY and still bounded to FORECAST sources —
// chooseCurrent (the KMA observation) is never part of this consensus.

/** One forecast source's daily array, as returned this cycle (returned-only). */
export interface SourceDailyForecast {
  source: ProviderId;
  daily: readonly DailyForecast[];
}

/**
 * Multi-source weighted daily precip consensus. `base` (the always-present
 * forecast source, Open-Meteo) fixes the output slots/order and every non-precip
 * field; for each date we gather POP / predicted_mm contributions from EVERY
 * source that returned this cycle and actually carries that date, then fuse with
 * the effective weights.
 *
 * No fabrication: a source missing a date is dropped from that slot (never
 * imputed, never treated as 0). `predicted_mm` self-restricts to amount-bearing
 * sources inside fuseWeightedPrecip, so amount-less sources (KMA forecast, Pirate,
 * MET) contribute to POP but never drag the mm average toward 0. A slot with no
 * contributor at all keeps `base` unchanged (so an empty source set — e.g. the
 * all-sources-down fallback — is the identity over `base`).
 */
export function fuseMultiSourceDaily(
  base: readonly DailyForecast[],
  sources: readonly SourceDailyForecast[],
  weights: Record<string, number>,
): DailyForecast[] {
  const byDate = new Map<ProviderId, Map<string, DailyForecast>>();
  for (const s of sources) {
    const m = new Map<string, DailyForecast>();
    for (const d of s.daily) m.set(d.date, d);
    byDate.set(s.source, m);
  }
  return base.map((b) => {
    const contributions: PrecipContribution[] = [];
    for (const s of sources) {
      const entry = byDate.get(s.source)?.get(b.date);
      if (!entry) continue; // source lacks this date → drop it (no imputation)
      contributions.push({
        source: s.source,
        pop: entry.precipitationProbability,
        predicted_mm: entry.precipitationAmount ?? null,
      });
    }
    if (contributions.length === 0) return b; // no source covered this date → keep base as-is
    const f = fuseWeightedPrecip(contributions, weights);
    const out: DailyForecast = { ...b, precipitationProbability: f.pop };
    // Only rewrite predicted_mm when base actually carried one — never add a null
    // amount where the field was absent (that would change the payload shape).
    if (b.precipitationAmount !== undefined) out.precipitationAmount = f.predicted_mm;
    return out;
  });
}
