# Atomic Provider Snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make every Forecast Provider return one coherent, non-throwing Provider Snapshot from one cached generation.

**Architecture:** Keep the ordered provider registry and public weather records unchanged. Replace the split status/forecast interface with one read() entry point created by a shared provider factory; caller clusters consume the resulting Provider Snapshot or a daily projection.

**Tech Stack:** TypeScript, Node test runner, Next.js server modules, process-local cachedFetch.

## Global Constraints

- Preserve ProviderSnapshot, SkySnapshot, and WeatherIntelligence JSON fields.
- Preserve registry order, honest omission, stale-last-good behavior, and provider-specific sanitized messages.
- KMA warning reads remain independent from KMA forecast reads.
- Missing configuration performs no upstream work.
- Relative imports in test-reachable lib modules use explicit .ts extensions.
- Add no dependency.

---

### Task 1: Define the atomic provider module

**Files:**
- Modify: lib/providers/base.ts
- Modify: lib/providers/read.ts
- Modify: lib/providers/read.test.ts

**Interfaces:**
- Produces: WeatherProvider with id, name, and read(): Promise<ProviderSnapshot>
- Produces: createWeatherProvider(definition): WeatherProvider
- Preserves: readAvailableProviderDaily(provider): Promise<AvailableProviderDaily | null>

- [ ] **Step 1: Write the failing coherence tests**

Add tests that create a provider through createWeatherProvider with a normalized loader and TTL. Assert loader call count is one, status.lastUpdated equals current.time, and status cache flags match that one cached generation. Add missing-configuration and thrown-loader cases:

~~~ts
const provider = createWeatherProvider({
  id: "open-meteo",
  name: "Open-Meteo",
  messages: {
    ok: "ok",
    stale: "stale",
    needsConfig: "config",
    error: "error",
  },
  missingConfiguration: () => [],
  ttlMs: 60_000,
  load: async () => {
    calls += 1;
    return { current, hourly, daily };
  },
});
const snapshot = await provider.read();
assert.equal(calls, 1);
assert.equal(snapshot.status.lastUpdated, snapshot.current?.time);
~~~

- [ ] **Step 2: Run the focused test and verify red**

Run: node --test lib/providers/read.test.ts

Expected: FAIL because createWeatherProvider and WeatherProvider.read do not exist.

- [ ] **Step 3: Implement the smallest deep module**

Change WeatherProvider to:

~~~ts
export interface WeatherProvider {
  readonly id: WeatherProviderStatus["id"];
  readonly name: string;
  read(): Promise<ProviderSnapshot>;
}
~~~

Add a factory definition with ttlMs and a load returning NormalizedForecast. The factory derives the cache key from provider id, calls cachedFetch once, performs the missing-configuration check, builds coherent status/data, catches unexpected failures, and returns empty weather for non-ok results. Derive the default generic error inside the factory. Update readAvailableProviderDaily to project provider.read().

- [ ] **Step 4: Run the focused test and verify green**

Run: node --test lib/providers/read.test.ts

Expected: PASS for coherent success, stale success, missing configuration, failure isolation, and daily projection.

- [ ] **Step 5: Commit the module seam**

~~~bash
git add lib/providers/base.ts lib/providers/read.ts lib/providers/read.test.ts
git commit -m "refactor: make provider reads atomic"
~~~

### Task 2: Migrate all Forecast Provider adapters

**Files:**
- Modify: lib/providers/open-meteo.ts
- Modify: lib/providers/met-norway.ts
- Modify: lib/providers/kma.ts
- Modify: lib/providers/pirate-weather.ts
- Modify: lib/providers/weather-api.ts
- Modify: lib/providers/kma.test.ts
- Modify: lib/reliability/forecastSources.test.ts
- Create: lib/reliability/forecastLog.test.ts

**Interfaces:**
- Consumes: createWeatherProvider and WeatherProvider.read from Task 1
- Produces: five production WeatherProvider adapters with unchanged ids, names, cache TTLs, and normalized weather

- [ ] **Step 1: Migrate tests to the atomic interface and verify red**

Replace fake getProviderStatus/readForecast methods with one read method or factory loader. Change KMA assertions to inspect (await kmaProvider.read()).current and .status. Add forecastLog tests proving one read per provider and omission on unavailable/target-date-missing data.

Run: node --test lib/providers/kma.test.ts lib/reliability/forecastSources.test.ts lib/reliability/forecastLog.test.ts

Expected: FAIL while production adapters still implement the removed split interface.

- [ ] **Step 2: Convert each production adapter**

Keep each fetchSnapshot normalization implementation and remove each provider-local getSnapshot wrapper. Construct each exported provider with createWeatherProvider, passing the fetchSnapshot loader, existing TTL, configuration check, localized messages, and sanitized failure classifier. KMA short-term configuration uses only KMA_SHORT_TERM_API_KEY; warning functions remain outside the forecast provider.

- [ ] **Step 3: Migrate caller clusters**

Update lib/liveSkySnapshot.production.ts and lib/weatherIntelligence.production.ts to call provider.read(). Keep reliability collectors using readAvailableProviderDaily so omission and timeout behavior remain centralized.

- [ ] **Step 4: Run provider and assembler tests**

Run: node --test lib/providers/*.test.ts lib/reliability/forecastSources.test.ts lib/reliability/forecastLog.test.ts lib/liveSkySnapshot.test.ts lib/weatherIntelligence.test.ts

Expected: PASS with one coherent provider read and unchanged public records.

- [ ] **Step 5: Run TypeScript and lint**

Run: npx tsc --noEmit

Expected: exit 0 with no split-interface references.

Run: npm run lint

Expected: exit 0.

- [ ] **Step 6: Commit provider migration**

~~~bash
git add lib/providers lib/reliability/forecastSources.test.ts lib/reliability/forecastLog.test.ts lib/liveSkySnapshot.production.ts lib/weatherIntelligence.production.ts
git commit -m "refactor: migrate forecast providers to atomic snapshots"
~~~

### Task 3: Synchronize provider documentation

**Files:**
- Modify: README.md
- Modify: docs/weather-sources.md
- Modify: lib/reliability/README.md
- Modify: CLAUDE.md
- Modify: .env.example

**Interfaces:**
- Documents: Provider Snapshot as one coherent read used by all four caller clusters

- [ ] **Step 1: Update current architecture descriptions**

Describe atomic availability/freshness/weather coherence, shared cache reuse, honest omission, and unchanged provider ordering. Refresh source-location comments in .env.example and the provider invariant in CLAUDE.md.

- [ ] **Step 2: Verify repository references**

Run: rg -n "getProviderStatus|readForecast" README.md docs lib/reliability/README.md .env.example CLAUDE.md lib --glob "!*.test.ts"

Expected: no stale production-interface references.

- [ ] **Step 3: Commit documentation**

~~~bash
git add README.md docs/weather-sources.md lib/reliability/README.md .env.example
git add -f CLAUDE.md
git commit -m "docs: describe atomic provider snapshots"
~~~
