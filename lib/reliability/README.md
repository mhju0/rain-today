# Precipitation source reliability

오늘비 can learn bounded per-provider precipitation weights from completed Seoul forecasts. The scheduled job is separate from request handling; it never fabricates missing forecasts or observations, and it does not make the core site depend on the learning state.

## Daily pipeline

`npm run reliability:daily -- [--recover <ref>]` runs the thin `scripts/precip-reliability.ts` adapter. It delegates durable work to `runReliabilityStateTransaction`.

The transaction:

1. Reads the current snapshot from the remote `reliability-state` branch.
2. Optionally fetches and unions an explicit recovery ref.
3. Materializes the snapshot in an isolated temporary directory and runs `cycle.ts` there.
4. Re-reads the remote tip and rejects invalid or regressive candidates.
5. Publishes the exact manifest with revision compare-and-swap protection.

Inside the isolated candidate, the daily cycle:

1. Read one Provider Snapshot from every provider, project tomorrow's daily precipitation forecast only from available snapshots, and append one record per returned source to `forecast-log.jsonl`.
2. Fetch yesterday's completed KMA ASOS daily precipitation observation for station 108.
3. Join prior forecasts to that independent observation and append informative skill records to `daily-skill.jsonl`.
4. Apply unprocessed daily losses to the bounded multiplicative-weights state in `source-weights.json`.

Missing observation data, non-OK provider snapshots, target-date-missing forecasts, and correct-dry days are skipped where they carry no useful scoring information. A provider snapshot keeps availability and daily data from the same cached generation, so skipped sources are honestly omitted rather than fabricated. A successful independent observation still refreshes the state's health timestamp, so a dry stretch does not make healthy learned weights look stale; a missing observation does not refresh it. Repeated runs are idempotent by date and source.

## Scoring

- Measurable rain is at least `0.1 mm`.
- When a provider lacks a clean precipitation amount, rain/no-rain falls back to probability at the configured threshold.
- A miss is penalized more than a false alarm.
- Correct-dry days do not improve a source's weight.
- Quantitative amount error is scored only when rain occurred and the provider supplied an amount.
- Weights remain normalized and bounded by the floor and cap in `weights.ts`.

All thresholds and loss constants are named and unit-tested in `score.ts` and `weights.ts`.

## Runtime gate

The web runtime reads `source-weights.json` through the narrow HTTP reader in `runtimeWeightsSource.ts`. It never imports the batch filesystem or Git adapters into the Next request bundle.

The production reader is pinned to this repository's raw `reliability-state` URL. The injectable reader factory still restricts callers to HTTPS on `raw.githubusercontent.com`.

Every remote response is schema-validated (timestamp, event count, unique dates, finite non-negative normalized weights). Missing, unavailable, or invalid state never throws into `/api/sky`: the loader retains a cached last-good state when possible, otherwise the gate uses equal weights. The gate behaves as follows:

- Missing, corrupt, stale, or insufficiently trained state uses equal fallback.
- Intermediate training linearly blends equal and learned weights.
- Fully warmed state uses the bounded learned weights.
- Multi-source learned precipitation weighting defaults to on. `MULTI_SOURCE_PRECIP=0` is the emergency opt-out; when off, `/api/sky` retains the Open-Meteo precipitation baseline byte-for-byte.
- When enabled, sources fetch concurrently with a per-source timeout through the shared Provider Snapshot read. A snapshot's availability, freshness metadata, and daily weather stay coherent; only available returned values participate, and weights renormalize over that subset.
- Missing precipitation values are excluded rather than converted to zero. If every optional source fails, the baseline remains unchanged.
- `/api/sky` always exposes a small, non-secret `precipLearning` summary for the advanced diagnostics: gate mode, evidence depth, last observation check, and exact effective versus stored weights. `RELIABILITY_DEBUG=1` additionally exposes the legacy raw `precipWeighting` block; leave it unset in production unless actively investigating the model.

## Storage and automation

The public `reliability-state` branch owns the durable manifest under `data/reliability/`:

- `forecast-log.jsonl`
- `daily-skill.jsonl`
- `source-weights.json`

Release branches ignore the JSON/JSONL outputs and retain only `data/reliability/.gitkeep`. `vercel.json` disables deployments for `reliability-state`.

The workflow runs daily and supports manual dispatch. It preserves checkout credentials and `contents: write`, then invokes the transaction CLI once after Node setup.

Concurrency serializes jobs. The Git adapter reads the branch through private refs, materializes temporary worktrees, commits only the canonical manifest, and publishes normal fast-forward commits guarded by a lease.

The transaction refreshes the remote tip before publication. It refuses to lose or replace forecast/skill keys, processed dates, event count, or a newer learned checkpoint.

Only explicit recovery may repair an existing row or prefer a checkpoint backed by stronger evidence. Any invalid snapshot, regression, or revision conflict fails without moving `reliability-state`.

For recovery, dispatch with `recovery_ref` set to a full known-good commit SHA or valid remote ref. The Git adapter fetches it into a private temporary ref; the workflow contains no restore or recovery shell.

Known-good values win duplicate row keys, unique newer rows survive, and the checkpoint with stronger event and processed-date evidence is retained. Invalid, unfetchable, or incomparable recovery fails before publication.

Scoring requires `KMA_OBSERVATION_API_KEY` for the KMA ASOS daily service. `KMA_SHORT_TERM_API_KEY` is only a fallback and may not have the required subscription. A missing or unauthorized observation key causes a scoring skip, not fabricated ground truth.

Before relying on learned production weights, verify the latest scheduled workflow and the public `reliability-state` snapshot. Local tests cannot prove that remote scheduling, secrets, or publication are healthy.

## Files

| File | Responsibility |
| --- | --- |
| `forecastLog.ts` | Normalize provider forecasts for logging |
| `groundTruth.ts` | Fetch KMA ASOS completed observations |
| `score.ts` | Pure daily skill calculation |
| `weights.ts` | Pure bounded multiplicative-weight update |
| `runtimeWeights.ts` | Pure warm-up, staleness, and effective-weight gate |
| `runtimeWeightsSource.ts` | Schema-validated durable HTTP reader for Vercel/runtime |
| `forecastSources.ts` | Single-flight, TTL-cached provider fan-out with timeouts |
| `cycle.ts` | Dependency-injected daily reliability orchestration |
| `stateSnapshot.ts` | Recovery union and monotonic history/checkpoint guard |
| `persistence.ts` | Isolated/local filesystem adapter and snapshot I/O |
| `gitStateTarget.ts` | Versioned remote `reliability-state` read/publish adapter |
| `stateTransaction.ts` | Restore, recover, run, validate, refresh, and publish transaction |
| `scripts/precip-reliability.ts` | Scheduled transaction CLI and reporting adapter |
| `scripts/reliability-state.ts` | Manual directory inspection/recovery utilities |
