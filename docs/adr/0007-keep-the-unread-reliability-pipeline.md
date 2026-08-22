---
status: accepted
---

# Keep `lib/reliability/` running, unread, and revisit on 2026-09-18

Retiring `/api/sky` and `/api/weather` (#71) removed the only HTTP path that read
`lib/reliability/`'s learned weights. Issue #62 asked what follows: retire the module
with the route, keep it running as an experiment nothing reads, or repoint it at
something served.

## What the import graph actually says

The directory does not have one fate. Walked to file granularity, its sixteen source
files split three ways:

- **Served.** `score.ts` and `types.ts` are reached on every request, through
  `app/api/local-forecast` → `lib/localForecast.ts` → `lib/performance/performance.ts`
  → `lib/performance/seedScore.ts`. Because evidence is currently in `mode: "seed"`,
  this is live, not latent. "Nothing in `lib/reliability/` reaches a user" was recorded
  as verified on map #59 and was false; a directory-level grep produced it, and
  following imports refuted it.
- **Scheduled only.** Ten files run from the daily `precip-reliability` job and from
  no request path.
- **Unserved but retained.** `config.ts`, `forecastSources.ts`, `runtimeWeights.ts` and
  `runtimeWeightsSource.ts` are reached only from `lib/liveSkySnapshot*.ts`, which #71
  kept and unrouted. They are dead to a visitor, not dead to the build.

So "retire `lib/reliability/`" was never available as stated. At minimum `score.ts` and
`types.ts` stay.

## Decision

**Keep the scheduled pipeline running unchanged, and revisit on 2026-09-18.** Delete
nothing now.

## Why

The pipeline has just converged. Its state on `reliability-state` carries 111 scored
events over 32 dates, and the weights have separated to both bounds — MET Norway pinned
at the 0.6 cap, WeatherAPI at 0.0594 against the 0.05 floor. That is the first learned
signal either pipeline has produced. Meanwhile the served pipeline is still on seed
evidence, so the product is quoting retrospective archive estimates while a live
single-station result sits beside it unread.

Deleting a converged experiment the month it starts producing output, in order to tidy a
directory, trades information for neatness. The running cost is a scheduled job on a
public repo, where Actions minutes are free.

The cost of keeping it is comprehension, not money: a reader meets two scoring pipelines
and cannot tell which one matters. That is answered with prose — `README.md`,
`docs/weather-sources.md` and this record all now say which pipeline serves a visitor —
rather than with deletion.

## Consequences

- The revisit date is 2026-09-18, roughly one month of further accumulation. Two
  questions decide it: whether the served pipeline has left seed mode, and whether the
  two pipelines' learned orderings agree. If they agree, the single-station experiment
  has told us what it can and can retire. If they disagree, that disagreement is
  evidence about the projection policy, not clutter.
- The four unserved files are not deleted separately. They belong to
  `lib/liveSkySnapshot*.ts`, whose retention #71 already decided; they retire with it or
  not at all.
- No user-visible behaviour changes. Nothing served reads the learned-weights file
  today and nothing will before the revisit.
