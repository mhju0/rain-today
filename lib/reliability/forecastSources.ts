import { cachedFetch } from "../cache.ts";
import { readAvailableProviderDaily } from "../providers/read.ts";
import { providers } from "../providers/registry.ts";
import type { WeatherProvider } from "../providers/base";
import type { SourceDailyForecast } from "../skyFusion";

/**
 * Phase 4 — shared, TTL-cached multi-source forecast fetch for the runtime precip
 * consensus. This path is production-default; MULTI_SOURCE_PRECIP=0 is the
 * emergency opt-out in lib/liveSkySnapshot.production.ts.
 *
 * REUSE, don't duplicate: the daily forecasts come straight from the existing
 * provider registry (through the shared normalized provider-read seam that the
 * offline pipeline also uses) — no parallel fetch logic, no new providers, all
 * keys stay server-side.
 *
 * Three properties make this safe to put on the live /sky path:
 *  - **Shared TTL cache** (FORECAST_CACHE_TTL_MS): the whole collection is fetched
 *    at most once per window, so concurrent /api/sky requests reuse one cycle
 *    instead of fanning out 5 live upstream calls each.
 *  - **Single-flight**: even the first concurrent burst (cache cold) triggers ONE
 *    upstream cycle, not N — callers within a cycle share the same in-flight promise.
 *  - **Per-source timeout + independent failure** (PER_SOURCE_TIMEOUT_MS): one slow
 *    or failing provider can't stall the response; it is simply DROPPED from this
 *    cycle's result. A dropped source contributes nothing to the consensus — it is
 *    never imputed (the fusion renormalizes over whoever actually returned).
 *
 * This layer never throws: every fetcher catches, so a fully-failed cycle resolves
 * to `[]` (the snapshot pipeline then keeps the single-source baseline).
 */

const FORECAST_SOURCES_KEY = "reliability-runtime-forecast-sources";
const MIN_SOURCE_TIMEOUT_MS = 10;
const MAX_SOURCE_TIMEOUT_MS = 15_000;

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return boundedSourceTimeout(v, fallback);
}

export function boundedSourceTimeout(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_SOURCE_TIMEOUT_MS, Math.max(MIN_SOURCE_TIMEOUT_MS, Math.trunc(value)));
}

/** Shared cache window for the whole multi-source collection (default ~12 min). */
export const FORECAST_CACHE_TTL_MS = envInt("FORECAST_CACHE_TTL_MS", 12 * 60 * 1000);
/** Per-source budget — one slow provider can't stall the cycle (default 4 s). */
export const PER_SOURCE_TIMEOUT_MS = envInt("PER_SOURCE_TIMEOUT_MS", 4000);

/** Reject after `ms`, otherwise resolve with the wrapped promise's value. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("forecast-source-timeout")), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Fetch one provider's daily forecast, or null if it is not configured, fails, or
 * exceeds the per-source timeout. Never throws (the null IS the "dropped" signal).
 */
async function fetchSourceDaily(
  provider: WeatherProvider,
  timeoutMs: number,
): Promise<SourceDailyForecast | null> {
  try {
    return await withTimeout(
      (async () => {
        return await readAvailableProviderDaily(provider);
      })(),
      timeoutMs,
    );
  } catch {
    return null; // timeout or fetch error → drop this source from the cycle
  }
}

async function collectUncached(
  providerList: readonly WeatherProvider[],
  timeoutMs: number,
): Promise<SourceDailyForecast[]> {
  const results = await Promise.all(providerList.map((p) => fetchSourceDaily(p, timeoutMs)));
  return results.filter((r): r is SourceDailyForecast => r !== null);
}

/**
 * The runtime multi-source forecast collection: TTL-cached + single-flight.
 * Returns only the sources that actually returned this cycle (returned-only); an
 * all-failed cycle resolves to `[]`. `providerList`/`opts.timeoutMs` are injectable
 * for tests; production calls take the defaults.
 */
export async function collectForecastSources(
  providerList: readonly WeatherProvider[] = providers,
  opts: { timeoutMs?: number } = {},
): Promise<SourceDailyForecast[]> {
  const timeoutMs = boundedSourceTimeout(opts.timeoutMs, PER_SOURCE_TIMEOUT_MS);
  const { value } = await cachedFetch(FORECAST_SOURCES_KEY, FORECAST_CACHE_TTL_MS, () =>
    collectUncached(providerList, timeoutMs),
  );
  return value;
}
