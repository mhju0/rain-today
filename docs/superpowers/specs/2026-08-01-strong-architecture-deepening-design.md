# Strong architecture deepening

## Status

Approved for implementation on 2026-08-01.

## Objective

Implement the three Strong candidates from the SeoulSky architecture review:

1. Make Reliability Publication one durable transaction and move Reliability Snapshots off the application release path.
2. Put Radar Timeline and Radar Frame delivery behind one deep module.
3. Make every Forecast Provider return one atomic Provider Snapshot.

The implementation must preserve public weather and radar contracts, honest degradation, Seoul-specific time rules, attribution, and current user-visible behavior except where radar failure becomes more explicit. Repository documentation and GitHub metadata must describe the resulting state consistently.

## Non-goals

- Do not combine Sky Snapshot and Weather Intelligence; their latency and presentation roles remain distinct.
- Do not add a new weather source, radar source, database, object store, or user-facing feature.
- Do not change precipitation scoring or Learned Weights mathematics.
- Do not change the number, cadence, or observed-only meaning of Radar Timeline frames.
- Do not introduce a general infrastructure framework for hypothetical storage or radar implementations.
- Do not change public JSON field names or successful Radar Frame bytes.

## Design choice

Deepen the existing seams in place.

Rejected alternatives:

- A single weather-runtime module would mix live fusion, provider comparison, radar rendering, and historical learning. Its interface would be smaller at the route level but its implementation would lose locality.
- A maximally pluggable set of storage, cache, render, and provider adapters would support hypothetical deployments but add interface mass the project does not currently use.
- A batch radar artifact would centralize rendering further but would change browser delivery and cache behavior without measured need.

## 1. Durable Reliability Publication

### External interface

The scheduled adapter calls one transaction:

~~~ts
interface ReliabilityStateTransaction {
  run(request?: { recoveryRef?: string }): Promise<{
    outcome: "published" | "unchanged";
    revision: string;
    cycle: ReliabilityCycleResult;
  }>;
}
~~~

The workflow supplies provider credentials and an optional recovery ref, then invokes one npm command. It does not know snapshot filenames, Git worktree ordering, recovery materialization, or publication rules.

### Internal seam

~~~ts
interface ReliabilityStateTarget {
  read(ref?: string): Promise<{
    revision: string | null;
    snapshot: ReliabilitySnapshot | null;
  }>;
  publish(input: {
    expectedRevision: string | null;
    snapshot: ReliabilitySnapshot;
    message: string;
  }): Promise<{ revision: string; changed: boolean }>;
}
~~~

The production adapter uses a dedicated Git branch. Tests use an in-memory adapter for transaction behavior and a local bare-repository adapter for real Git behavior.

### Implementation ownership

The transaction module owns:

- the canonical three-file Reliability Snapshot manifest;
- branch restore from one authoritative revision;
- optional recovery union;
- isolated candidate materialization;
- the daily log → truth → score → learn cycle;
- candidate schema validation;
- remote-tip refresh and monotonic comparison;
- one-commit publication by expected revision;
- result reporting.

The Git adapter owns Git command execution, branch bootstrap mechanics, temporary worktrees, commit creation, and fast-forward push. The runtime HTTP adapter remains separate because it has a different caller and failure contract.

### Invariants and error handling

- A Reliability Snapshot contains exactly forecast history, skill history, and Learned Weights.
- All three records publish in one commit or none publish.
- Fatal provider-cycle, persistence, validation, Git, or publication-conflict errors reject without publication.
- A Scoring Skip is successful and may publish newly logged forecasts.
- Forecast and skill row keys, processed dates, scored-event count, timestamp strength, and weights never regress.
- Normal publication cannot replace an existing row. Explicit recovery may repair content only under the existing monotonic recovery rules.
- A moved branch tip causes a safe conflict instead of a force push.
- No secret or unrelated JSON file may enter the state branch.
- Runtime read failure keeps cached last-good state when available, then selects Equal Fallback.

### Migration

1. Create vercel.json with deployment disabled for reliability-state.
2. Seed the remote reliability-state branch from the current three tracked files and include the deployment exclusion.
3. Point runtime learned-weight reads and scheduled publication at that branch.
4. Verify the branch contains a valid Reliability Snapshot.
5. Remove the generated files from main and restore their ignore rules.
6. Verify a state-only branch push does not create a Vercel deployment.

The branch is seeded before main cleanup so no cycle can cold-start over accumulated evidence.

## 2. Radar delivery

### External interface

Both existing HTTP adapters use one production module:

~~~ts
interface RadarDelivery {
  timeline(signal?: AbortSignal): Promise<KmaRadarFrames>;
  frame(key: string, signal?: AbortSignal): Promise<
    | { kind: "ready"; png: Uint8Array }
    | { kind: "invalid" }
    | { kind: "busy"; retryAfterSeconds: number }
    | { kind: "cancelled" }
    | { kind: "unavailable" }
  >;
}
~~~

The frames route serializes timeline(). The frame route maps the discriminated frame result to the existing PNG success contract and explicit non-cacheable failures. Request rate limiting remains in the HTTP adapters; render admission belongs inside the radar module.

### Internal seam

A narrow KMA radar adapter supplies configuration state, immutable grid bytes, and georeference data. Production uses KMA; module tests use an in-memory adapter. Grid parsing, Seoul cropping, Web Mercator reprojection, colour mapping, and PNG encoding remain in-process implementations.

### Implementation ownership

The radar-delivery module owns:

- KST frame-key validation and the allowed delivery window;
- newest deliverable-frame discovery;
- Radar Timeline construction;
- same-key single-flight work;
- immutable per-key render caching;
- active and queued render admission;
- queue cancellation through AbortSignal;
- KMA error classification;
- frame rendering orchestration.

The pure grid, geo, Mercator, and presentation modules remain independently testable. Both routes become shallow adapters over the same module.

### Browser behavior

The presentation no longer starts thirteen cold image requests. It keeps the active frame and at most the next playback frame in flight, then progressively warms the remaining timeline. A failed frame is recorded explicitly; playback selects the nearest available frame and exposes an honest unavailable state instead of retaining a successful label over an empty image.

### Invariants and error handling

- Radar Timeline remains thirteen observed frames, five minutes apart, oldest to newest.
- Invalid, future, misaligned, or expired keys never reach KMA.
- Identical concurrent frame requests share one render.
- Admission limits apply to timeline probes and direct frame delivery.
- Cancellation removes queued work and releases capacity.
- Render capacity recovers after success, rejection, timeout, malformed data, and cancellation.
- Successful PNG bytes are immutable and cacheable by key.
- Failure responses are non-cacheable and reveal no credential or raw upstream detail.
- Missing configuration or upstream failure preserves the explicit unavailable presentation.
- KMA, CARTO, and OpenStreetMap attribution remains visible.

## 3. Atomic Provider Snapshot

### External interface

~~~ts
interface WeatherProvider {
  readonly id: ProviderId;
  readonly name: string;
  read(): Promise<ProviderSnapshot>;
}
~~~

read() never rejects. It returns one coherent Provider Snapshot containing availability, freshness, cache state, and normalized current/hourly/daily weather.

### Construction seam

Forecast Provider implementations are created through a shared factory whose internal adapter supplies:

- provider identity and localized descriptions;
- missing-configuration detection;
- one cached normalized loader;
- sanitized provider-specific failure classification.

The factory derives cache identity from provider identity and owns common status construction, empty-weather shaping, stale-last-good behavior, and unexpected-failure isolation.

### Caller migration

- Sky Snapshot reads Open-Meteo and KMA through read().
- Weather Intelligence reads the ordered registry through read().
- Runtime precipitation consensus and daily reliability logging project daily weather from the same Provider Snapshot.
- KMA warnings stay independent because they use a different source capability, key, cache, and failure policy.

Public SkySnapshot, WeatherIntelligence, and ProviderSnapshot shapes remain unchanged.

### Invariants and error handling

- An ok Provider Snapshot contains coherent current, hourly, and daily weather from one cached generation.
- status.lastUpdated, fromCache, and stale describe that same generation.
- A non-ok Provider Snapshot contains empty weather.
- Missing configuration performs no upstream work and exposes only environment-variable names.
- Stale last-good weather remains usable and visibly stale.
- Provider failure becomes an honest error Provider Snapshot without secret or raw-error leakage.
- Forecast Provider registry order remains semantic: the first live provider is primary.
- Reliability collectors omit unavailable, failing, timed-out, and target-date-missing providers instead of treating them as zero.
- Shared cache and single-flight reuse remains intact across concurrent caller clusters.

## Test strategy

Implementation follows red-green-refactor at each seam.

### Reliability tests

- A full transaction restores, runs, validates, and publishes exactly one commit.
- A local bare repository verifies branch creation, expected-revision publication, fast-forward behavior, and exact manifest.
- Fatal cycle failure, malformed state, regression, and moved-tip conflict publish nothing.
- A Scoring Skip can publish newly logged forecasts.
- Explicit recovery keeps existing monotonic repair rules.

### Radar tests

- Thirteen simultaneous cold frame calls never exceed configured active capacity.
- Same-key calls perform one KMA read.
- Queue cancellation releases admission.
- Success, upstream failure, timeout, malformed grid, and cancellation all restore capacity.
- Invalid keys perform zero upstream work.
- Timeline fallback finds the newest deliverable frame without inventing nowcast data.
- Browser preload keeps the agreed in-flight limit and handles a failed frame honestly.
- Existing KST, grid, geo, Mercator, PNG, presentation, and attribution tests remain green.

### Provider tests

- A generation-changing fake proves status and weather come from one logical read.
- Every provider performs one atomic read through the shared factory.
- Missing configuration performs zero upstream work.
- Stale success remains coherent.
- Failure returns error status plus empty weather without rejecting.
- Runtime and daily collectors still omit unavailable sources and preserve timeouts.
- Existing Sky Snapshot and Weather Intelligence behavior remains green without fixture leakage past the seam.

### Repository verification

Run:

~~~bash
npm run lint
npx tsc --noEmit
npm test
npm run build
~~~

Then verify the reliability-state branch contents, raw learned-weight URL, scheduled transaction dry path, Vercel branch exclusion, live /api/sky, deferred /api/weather, Radar Timeline, and at least one Radar Frame when configured.

## Documentation and metadata synchronization

Update all current, tracked descriptions of these areas:

- README.md: learning pipeline, architecture diagram, engineering choices, radar behavior, stack, limits, and verification.
- docs/weather-sources.md: atomic Provider Snapshot and radar-delivery semantics plus implementation map.
- lib/reliability/README.md: transaction, state branch, recovery, runtime read, commands, and file map.
- .env.example: state URL commentary and any stale source references.
- CLAUDE.md: repository invariants and current module ownership.
- Code comments in provider, radar, route, reliability, and workflow files.
- CONTEXT.md: canonical project language.
- docs/adr/0001-separate-reliability-state-from-release-history.md: the durable publication decision.

Historical design records that do not claim to document current architecture remain unchanged.

After implementation and verification, update the GitHub description to:

> Cinematic Seoul weather with KMA radar, graceful multi-provider fusion, and a precipitation ensemble that learns from verified KMA observations.

The repository homepage remains https://seoulsky.vercel.app/sky.

## Commit structure

Use reviewable commits:

1. Record the approved design, language, and state-publication decision.
2. Implement atomic Provider Snapshots.
3. Implement radar delivery.
4. Implement durable Reliability Publication and migrate state.
5. Synchronize documentation and GitHub metadata.
