# Precipitation source reliability

SeoulSky can learn bounded per-provider precipitation weights from completed Seoul forecasts. The scheduled job is separate from request handling; it never fabricates missing forecasts or observations, and it does not make the core site depend on the learning state.

## Daily pipeline

`npm run reliability:daily` runs the thin `scripts/precip-reliability.ts` adapter over the dependency-injected cycle in `cycle.ts`:

1. Collect tomorrow's daily precipitation forecast from every available provider and append one record per source to `forecast-log.jsonl`.
2. Fetch yesterday's completed KMA ASOS daily precipitation observation for station 108.
3. Join prior forecasts to that independent observation and append informative skill records to `daily-skill.jsonl`.
4. Apply unprocessed daily losses to the bounded multiplicative-weights state in `source-weights.json`.

Missing observation data, missing forecasts, and correct-dry days are skipped where they carry no useful scoring information. A successful independent observation still refreshes the state's health timestamp, so a dry stretch does not make healthy learned weights look stale; a missing observation does not refresh it. Repeated runs are idempotent by date and source.

## Scoring

- Measurable rain is at least `0.1 mm`.
- When a provider lacks a clean precipitation amount, rain/no-rain falls back to probability at the configured threshold.
- A miss is penalized more than a false alarm.
- Correct-dry days do not improve a source's weight.
- Quantitative amount error is scored only when rain occurred and the provider supplied an amount.
- Weights remain normalized and bounded by the floor and cap in `weights.ts`.

All thresholds and loss constants are named and unit-tested in `score.ts` and `weights.ts`.

## Runtime gate

The web runtime reads `source-weights.json` through the narrow HTTP reader in `runtimeWeightsSource.ts`; it never imports the batch filesystem adapter into the Next request bundle. By default the reader uses this repository's raw `main` URL. `RELIABILITY_WEIGHTS_URL` can point it at another durable JSON endpoint for a different deployment.

Every remote response is schema-validated (timestamp, event count, unique dates, finite non-negative normalized weights). Missing, unavailable, or invalid state never throws into `/api/sky`: the loader retains a cached last-good state when possible, otherwise the gate uses equal weights. The gate behaves as follows:

- Missing, corrupt, stale, or insufficiently trained state uses equal fallback.
- Intermediate training linearly blends equal and learned weights.
- Fully warmed state uses the bounded learned weights.
- Multi-source learned precipitation weighting defaults to on. `MULTI_SOURCE_PRECIP=0` is the emergency opt-out; when off, `/api/sky` retains the Open-Meteo precipitation baseline byte-for-byte.
- When enabled, sources fetch concurrently with a per-source timeout. Only returned values participate, and weights renormalize over the available subset.
- Missing precipitation values are excluded rather than converted to zero. If every optional source fails, the baseline remains unchanged.
- `/api/sky` always exposes a small, non-secret `precipLearning` summary for the advanced diagnostics: gate mode, evidence depth, last observation check, and exact effective versus stored weights. `RELIABILITY_DEBUG=1` additionally exposes the legacy raw `precipWeighting` block; leave it unset in production unless actively investigating the model.

## Storage and automation

Runtime files live under `data/reliability/` and are tracked on `main`:

- `forecast-log.jsonl`
- `daily-skill.jsonl`
- `source-weights.json`

`.github/workflows/precip-reliability.yml` runs daily and can also be dispatched manually. It restores and persists only those state files on `main`, using a detached worktree so no state branch is created. The workflow serializes runs to avoid competing updates. Before every push, a tested monotonic guard re-reads the remote tip and refuses to lose or replace any forecast/skill row, processed date, event count, or newer weight timestamp. Only an explicit known-good recovery may repair the content of an existing row or replace a reset-only newer timestamp with a checkpoint backed by more events and a superset of processed dates. A rejected push leaves `main` unchanged.

For an explicit recovery, dispatch the workflow with `recovery_ref` set to the full 40-character SHA of a known-good commit (including a detached commit no longer reachable from the current tip), or a valid remote ref. Recovery fetches that object directly and unions it with the current state: known-good values win duplicate row keys, unique newer rows survive, and the checkpoint with the stronger evidence (event count plus processed-date coverage) is retained even when a reset wrote a later timestamp. An invalid/unfetchable ref or genuinely incomparable checkpoint fails closed without entering the persistence step.

For the July 2026 regression, the verified checkpoint is `29eea596fa3f538856733542c20967fdebdc93b7` (117 forecast rows through July 14, 51 skill rows, and 51 learned events updated July 10). Use that full SHA as `recovery_ref`; do not use its abbreviated form because detached short SHAs cannot be fetched reliably.

Scoring requires `KMA_OBSERVATION_API_KEY` for the KMA ASOS daily service. `KMA_SHORT_TERM_API_KEY` is only a fallback and may not have the required subscription. A missing or unauthorized observation key causes a scoring skip, not fabricated ground truth.

Before relying on learned production weights, personally verify the latest scheduled workflow and the tracked state on `main`. Local tests cannot prove that remote scheduling, secrets, or persistence are healthy.

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
| `persistence.ts` | Batch/local filesystem adapter and state snapshot I/O |
| `scripts/precip-reliability.ts` | Daily CLI adapter |
| `scripts/reliability-state.ts` | Recovery and pre-push guard CLI adapter |
