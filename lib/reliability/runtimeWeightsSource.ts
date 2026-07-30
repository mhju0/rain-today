import { cachedFetch } from "../cache.ts";
import { readResponseBytes } from "../httpResponse.ts";
import { CACHE_TTL_MS } from "../seoul.ts";
import type { WeightsState } from "./types.ts";
import { parseWeightsState } from "./weightsState.ts";

export const DEFAULT_RELIABILITY_WEIGHTS_URL =
  "https://raw.githubusercontent.com/mhju0/seoulsky/reliability-state/data/reliability/source-weights.json";

const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_WEIGHTS_BYTES = 512 * 1024;

function safeHttpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const privateHost =
      host === "localhost" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host === "[::1]" ||
      host.endsWith(".local") ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (url.protocol !== "https:" || privateHost || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Narrow durable-storage seam consumed by the production snapshot pipeline. */
export interface WeightsStateReader {
  read(): Promise<WeightsState | null>;
}

export interface HttpWeightsStateReaderOptions {
  url: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Read the state branch (or another durable JSON endpoint) without importing
 * Node filesystem modules into a Next request bundle. All remote bytes are
 * schema-validated before they can reach the weighting gate.
 */
export function createHttpWeightsStateReader({
  url,
  fetcher = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: HttpWeightsStateReaderOptions): WeightsStateReader {
  const safeUrl = safeHttpsUrl(url);
  return {
    async read() {
      try {
        if (!safeUrl) return null;
        const response = await fetcher(safeUrl, {
          cache: "no-store",
          headers: { Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return null;
        const bytes = await readResponseBytes(response, {
          maxBytes: MAX_WEIGHTS_BYTES,
          contentType: "application/json",
        });
        return parseWeightsState(JSON.parse(new TextDecoder().decode(bytes)));
      } catch {
        return null;
      }
    },
  };
}

/**
 * Memoize a durable reader behind the app's shared TTL cache. A failed or
 * invalid refresh is treated as an upstream failure, which preserves an
 * expired last-good cache entry; without one, callers receive null and the
 * pure runtime gate chooses equal weights.
 */
export function createRuntimeWeightsLoader(
  reader: WeightsStateReader,
  options: { cacheKey?: string; ttlMs?: number } = {},
): () => Promise<WeightsState | null> {
  const cacheKey = options.cacheKey ?? "reliability-source-weights";
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;

  return async () => {
    try {
      const result = await cachedFetch(cacheKey, ttlMs, async () => {
        const state = await reader.read();
        if (!state) throw new Error("reliability weights unavailable or invalid");
        return state;
      });
      return result.value;
    } catch {
      return null;
    }
  };
}

const configuredUrl = process.env.RELIABILITY_WEIGHTS_URL?.trim();
const productionReader = createHttpWeightsStateReader({
  url: configuredUrl || DEFAULT_RELIABILITY_WEIGHTS_URL,
});

/** Production Vercel adapter; never throws into the public snapshot route. */
export const loadWeightsStateCached = createRuntimeWeightsLoader(productionReader);
