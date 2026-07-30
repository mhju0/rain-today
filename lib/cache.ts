/**
 * In-memory TTL cache, shared across requests in the Node.js server process.
 * If a refresh fails and a stale entry exists, the stale value is served
 * (flagged) instead of throwing — providers degrade gracefully.
 */

interface CacheEntry<T> {
  value: T;
  storedAt: number;
  retryAt?: number;
}

const store = new Map<string, CacheEntry<unknown>>();
const pending = new Map<string, Promise<CachedResult<unknown>>>();
const failures = new Map<string, { error: unknown; retryAt: number }>();
const MAX_CACHE_ENTRIES = 128;
const DEFAULT_FAILURE_RETRY_MS = 30_000;

export interface CachedFetchOptions {
  /** Cooldown after an upstream failure, preventing request-driven retry storms. */
  failureRetryMs?: number;
}

export interface CachedResult<T> {
  value: T;
  ageMs: number;
  fromCache: boolean;
  /** true when the fetcher failed and we fell back to an expired entry */
  stale: boolean;
}

export async function cachedFetch<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  options: CachedFetchOptions = {},
): Promise<CachedResult<T>> {
  const entry = store.get(key) as CacheEntry<T> | undefined;
  const now = Date.now();
  const failureRetryMs = options.failureRetryMs ?? DEFAULT_FAILURE_RETRY_MS;

  if (entry && now - entry.storedAt < ttlMs) {
    touch(store, key, entry as CacheEntry<unknown>);
    return { value: entry.value, ageMs: now - entry.storedAt, fromCache: true, stale: false };
  }
  if (entry?.retryAt && now < entry.retryAt) {
    touch(store, key, entry as CacheEntry<unknown>);
    return { value: entry.value, ageMs: now - entry.storedAt, fromCache: true, stale: true };
  }

  const failure = failures.get(key);
  if (!entry && failure) {
    if (now < failure.retryAt) throw failure.error;
    failures.delete(key);
  }

  const inFlight = pending.get(key) as Promise<CachedResult<T>> | undefined;
  if (inFlight) return inFlight;

  const refresh = (async (): Promise<CachedResult<T>> => {
    try {
      const value = await fetcher();
      store.set(key, { value, storedAt: Date.now() });
      failures.delete(key);
      enforceLimit(store);
      return { value, ageMs: 0, fromCache: false, stale: false };
    } catch (err) {
      if (entry) {
        entry.retryAt = Date.now() + failureRetryMs;
        touch(store, key, entry as CacheEntry<unknown>);
        return { value: entry.value, ageMs: now - entry.storedAt, fromCache: true, stale: true };
      }
      failures.set(key, { error: err, retryAt: Date.now() + failureRetryMs });
      enforceLimit(failures);
      throw err;
    }
  })();
  pending.set(key, refresh as Promise<CachedResult<unknown>>);
  try {
    return await refresh;
  } finally {
    if (pending.get(key) === refresh) pending.delete(key);
  }
}

function touch<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
}

function enforceLimit<T>(map: Map<string, T>): void {
  while (map.size > MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

/** Drop one entry, or the whole cache. Used by tests to isolate cases. */
export function clearCache(key?: string): void {
  if (key === undefined) {
    store.clear();
    pending.clear();
    failures.clear();
  } else {
    store.delete(key);
    pending.delete(key);
    failures.delete(key);
  }
}
