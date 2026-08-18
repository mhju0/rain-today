# Local forecast performance

`lib/performance/` scores every eligible KMA ASOS station and feeds `/api/local-forecast`. It is the newer of the repository's two precipitation-scoring pipelines; `lib/reliability/` is the older single-station one. They share a vocabulary and the bounded-weight contract but not an implementation — see [ADR 0004](../../docs/adr/0004-two-precipitation-scoring-pipelines.md).

## Two evidence classes

The pipeline holds two kinds of evidence and never lets them blur together.

| | Forecast Capture (live) | Seed Comparison (retrospective) |
| --- | --- | --- |
| Source | providers polled at a fixed KST cohort | public forecast archives |
| Frozen before outcome | yes | no — the outcome already existed |
| Scored on | probability, Brier score | amount and rain/no-rain outcome |
| Cohort | `06` or `18` | none |
| Enters the Prospective Benchmark | yes | never |
| Influence | ramps to full | capped at `SEED_INFLUENCE` |
| Table | `performance_captures` | `performance_seed_comparisons` |

Seed evidence exists for one reason: prospective evidence needs about a month per station to mature, and a first-time visitor should not be shown equal weights while it accrues.

## Mode gate

`buildRecentPerformanceProfile` resolves exactly one mode:

| Condition | Mode |
| --- | --- |
| live mature, benchmark has too few comparable captures | `suspended` |
| live mature, adaptive blend prospectively worse than equal | `suspended` |
| live immature, seed mature | `seed` |
| live mature, ramping | `ramping` |
| live mature, full influence | `learned` |
| otherwise | `equal-fallback` |

Two ordering rules are load-bearing:

- Seed **cannot rescue a suspension.** A benchmark regression is a live verdict that the adaptive blend is currently worse than equal weighting; retrospective archive evidence is not grounds to overrule it.
- Mature live evidence **supersedes the seed entirely.** Learned weights are identical whether or not seed evidence is present.

## Seeding

Day-ahead archived forecasts come from Open-Meteo's Previous Runs API — the `_previous_day1` variables, which are the run issued the day before. The ordinary historical-forecast endpoint returns the day-of run, which is effectively a nowcast; scoring that would flatter every provider and distort the ranking. Ground truth comes from the KMA ASOS daily service, which accepts a date range, so a month of observations costs one request.

Each provider is seeded from the model that actually drives it:

| Provider | Seed model |
| --- | --- |
| Open-Meteo | `best_match` |
| MET Norway | `ecmwf_ifs025` |
| KMA | `kma_seamless` |
| Pirate Weather | `gfs_seamless` |
| WeatherAPI | *not seeded* |

WeatherAPI publishes no model lineage with a public forecast archive. It is omitted rather than given a guessed proxy, and keeps a neutral share so it is still blended.

Archives publish no probability, so seed rows carry an amount only. They are scored with `lib/reliability/score.ts` — rain/no-rain with an asymmetric miss penalty, plus an amount term on days it actually rained — and weighted through the same bounded floor/cap projection the live path uses.

## Commands

```bash
npm run performance:capture -- --cohort=06     # one live cohort (scheduled)
npm run performance:seed -- --start=2025-06-01 --end=2025-08-31
npm run performance:catalog                     # regenerate the fallback station catalog
```

`performance:seed` is offline, idempotent by `(station, date)`, and records a failed window rather than aborting, so a re-run costs only the re-fetch. It reads the station catalog from apihub `stn_inf` when that subscription is available and from `stationCatalog.ts` otherwise.

`PERFORMANCE_DATABASE_URL` is required by both. The station catalog additionally needs `KMA_APIHUB_KEY` with the `stn_inf` subscription; observations need `KMA_OBSERVATION_API_KEY`.

## Files

| File | Responsibility |
| --- | --- |
| `performance.ts` | Scoring, evidence gates, bounded weights, benchmark, mode resolution |
| `seed.ts` | Rebuild retrospective day-ahead evidence from public archives |
| `seedScore.ts` | Pure amount-based seed scoring and capped seed weights |
| `backfill.ts` | One-shot offline backfill orchestration |
| `stationCatalog.ts` | Generated fallback ASOS catalog — never hand-edited |
| `capture.ts` | Freeze one station/cohort prediction |
| `batch.ts` | Nationwide bounded live cohort run |
| `influence.ts` | Effective Influence and the blend it produces |
| `stations.ts` | Station Match against distance and elevation gates |
| `kma.ts` | ASOS station catalog and daily observations |
| `store.ts` | Durable boundary and the in-memory adapter |
| `postgres.ts` | Production adapter |
| `storeContract.ts` | One executable contract both adapters must satisfy |

## Testing

The PostgreSQL adapter is only reachable with a disposable database:

```bash
PERFORMANCE_STORE_CONTRACT_URL=postgres://… npm test
```

Without it the PostgreSQL half of the store contract is skipped, and the two adapters can diverge silently — which is exactly what the contract exists to prevent. Run it against a throwaway database before trusting a store change.
