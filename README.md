# 오늘비 · raintoday

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Local performance](https://github.com/mhju0/raintoday/actions/workflows/local-performance.yml/badge.svg)](https://github.com/mhju0/raintoday/actions/workflows/local-performance.yml)

오늘비 ("rain today") is a South Korea local rain forecast. It leads with when rain starts and stops at the user's chosen coordinate, shows the next 24 hours as a horizontal time axis, carries today and tomorrow as two separately-calculated figures, and — when sufficient prospective evidence exists — adjusts each provider's influence on the next-day figure using the Recent Performance Profile from its KMA Station Match.

**Live demo:** [raintoday.vercel.app](https://raintoday.vercel.app)

The interface is Korean, for Korean users. The captions below describe what each screen shows.

![The chooser: pick the device location, or search a Korean administrative area](public/screenshots/landing.webp)

*Nothing is requested until the visitor asks — the app never prompts for location automatically or infers it from an IP address. The three figures beside the two ways in are the same evidence the forecast ends on, stated before anyone commits a coordinate.*

![The rain window as a sentence, above the 24-hour time axis](public/screenshots/forecast.webp)

*The heading answers when, not whether — a probability alone cannot tell someone leaving at 09:00 from someone leaving at 21:00. The ribbon is eight 3-hour blocks on a plain 0–100% scale, with the umbrella threshold drawn at the value it names and the rain window marked across every block it covers. It is one provider's hourly series and says so, because the day figures below it are a blend of several. A block nobody published is hatched and shows a dash, never 0%.*

![Today and tomorrow as two cards, over the three evidence cards](public/screenshots/outlook.webp)

*Today and tomorrow are different calculations, so they are different surfaces and each card carries its own method tag — performance weighting is scored on next-day forecasts only and never claimed for today. Below them: the station the evidence comes from, every provider with the figure it actually gave and the influence it was granted, and the six-day outlook that is always an equal average.*

<img src="public/screenshots/mobile.webp" alt="The same forecast on a phone" width="320">

*On a phone the sentence and both day cards stay whole; only the ribbon scrolls sideways, so nobody has to swipe to get the answer. The location bar stays pinned through the full scroll.*

## Product contract

- The forecast target is the user's exact submitted coordinate inside the supported South Korea service area, validated against official administrative boundaries.
- The user explicitly taps for browser geolocation or searches for a Korean place. The app does not prompt automatically or infer location from an IP address.
- User coordinates are used for the request and are not written to the performance database.
- Local performance is evidence from the KMA Station Match, not a claim that the station is the user's location.
- Rain probability is the initial accuracy target. Rain-amount error is reported separately and never substituted for probability accuracy.
- Until evidence passes every gate, the forecast uses equal influence among providers that supplied a valid value.

## How recent performance works

The [`local-performance`](.github/workflows/local-performance.yml) workflow runs at fixed 06:10 and 18:10 KST cohorts. For every active KMA ASOS station it can read, one run:

1. stores yesterday's completed daily precipitation observation;
2. captures each available provider's next-day rain probability and amount;
3. freezes the adaptive and equal-weight outputs before the outcome exists;
4. writes the immutable capture and corrected station-day observation to PostgreSQL.

The serving profile keeps the two capture cohorts separate. Provider probability performance uses all completed days—including dry days—with a 30-day operating window and a 14-day half-life. It reports Brier score, misses, false alarms, and rainy-day amount MAE. Public evidence also includes the latest seven-day Brier slice.

Learned influence requires at least 30 comparable captures per provider plus both wet and dry evidence. It ramps from equal to learned influence, applies provider floors and caps, and renormalizes over the providers that actually answered the current request. The Prospective Benchmark freezes adaptive and equal outputs before outcomes and suspends learning if the adaptive output regresses or lacks a fair comparison set.

Learned influence applies only to tomorrow, the lead time the Capture Cohorts measure. Days 2–7 remain an equal-provider outlook until those horizons have their own prospective evidence.

This supports the claim “weighted by recently observed local performance.” It does not yet support a claim that 오늘비 is more accurate overall; that requires accumulated prospective results.

### Seed evidence before live evidence exists

Prospective evidence takes about a month per station to mature, which would leave a first-time visitor on equal weights. To avoid that, a station can be seeded with **retrospective** evidence rebuilt from public archives: what each provider's underlying model forecast a day ahead, joined to the KMA ASOS observation for that date.

Seed evidence is a separate class from a Forecast Capture, and stays separate:

- It is scored on forecast **amount** and rain/no-rain outcome, because archives publish no probability. It never enters the Brier path.
- It is stored in its own table, carries no cohort and no frozen blend, and therefore can never reach the Prospective Benchmark.
- Its influence is capped at half the distance from equal weighting, because it rests on model proxies rather than each provider's own published forecast.
- It applies **only** while live evidence is immature. It never overrides a benchmark suspension, and mature live evidence supersedes it entirely.
- A provider with no honest archive proxy — currently WeatherAPI — is not seeded at all and keeps a neutral share rather than being demoted for lacking one.

The page says which of the two is driving the blend, and in seed mode shows the wet-day miss rate rather than a Brier table.

Backfill is a one-shot offline job, not something a visitor waits on:

```bash
npm run performance:seed -- --start=2025-06-01 --end=2025-08-31
```

## User flow

The forecast is the site, so it is served at `/`:

1. choose precise browser location or search for a Korean place;
2. read when rain starts and stops, as one sentence;
3. read the shape of the next 24 hours on a horizontal time axis — eight 3-hour blocks from a single named provider;
4. compare today and tomorrow, each tagged with how it was calculated;
5. inspect the Station Match, each provider's probability and influence, and the longer outlook;
6. inspect recent Brier scores, misses, and false alarms per provider.

There is no ambient scene behind any of it. The page is one vertical read, and its only control is "위치 바꾸기".

## Architecture

```mermaid
flowchart TB
  Browser["Browser /"] --> Search["/api/locations/search"]
  Browser --> Local["/api/local-forecast"]
  Search --> Geocoding["Kakao Map administrative search · KR only"]
  Local --> Providers["Forecast provider snapshots at user coordinates"]
  Local --> Match["ASOS Station Match"]
  Match --> Database["PostgreSQL performance evidence"]
  Providers --> Blend["Equal or recent-performance influence"]
  Database --> Profile["Cohort-specific Brier profile and guardrail"]
  Profile --> Blend
  Blend --> Browser

  Schedule["06:10 and 18:10 KST workflow"] --> Catalog["KMA ASOS station catalog"]
  Schedule --> Captures["Immutable next-day provider captures"]
  Schedule --> Observations["Completed KMA ASOS observations"]
  Catalog --> Database
  Captures --> Database
  Observations --> Database
```

Important boundaries:

- `lib/location.ts` validates Korean coordinates and converts them to KMA grid coordinates.
- `lib/providers/*` reads normalized provider snapshots at a requested location.
- `lib/performance/performance.ts` owns scoring, evidence gates, bounded weights, and the Prospective Benchmark.
- `lib/performance/store.ts` defines persistence; `lib/performance/postgres.ts` is the production adapter.
- `lib/performance/capture.ts` freezes one station/cohort prediction; `lib/performance/batch.ts` orchestrates the nationwide bounded run.
- `lib/localForecast.ts` combines exact-coordinate forecasts with nearby-station evidence without persisting user coordinates.
- `lib/performance/influence.ts` derives Effective Influence and the blend it produces, for both the capture and serving paths.
- `lib/performance/seed.ts` rebuilds retrospective day-ahead evidence from public archives; `lib/performance/seedScore.ts` scores it; `lib/performance/backfill.ts` orchestrates the one-shot offline run.
- `lib/localForecastView.ts` projects that response onto the flat contract `/api/local-forecast` returns, so the page never reads the domain model directly.
- `lib/forecast/blocks.ts` folds a now-anchored hourly series into eight 3-hour blocks; `lib/forecast/rainWindow.ts` reads the rain window out of them. A block with no published probability stays null rather than 0%, and an unpublished block ends a run rather than extending it.
- `app/api/local-forecast` and `app/api/locations/search` are rate-limited HTTP adapters.

The forecast is served at `/`. The retired `/atmosphere` and `/diagnostics` routes redirect there. The original cinematic Seoul sky scene is unrouted; `/api/sky` and `/api/weather` still serve its payloads.

오늘비 runs a **second, older scoring pipeline** alongside the one above. `lib/reliability/` scores a single station (서울 108) with an online update, persists to the `reliability-state` branch, and feeds the live `/api/sky` snapshot; `lib/performance/` scores every eligible station in batch and feeds `/api/local-forecast`. They share a vocabulary and a bounded-weight contract but not an implementation, and are deliberately not merged — see [ADR 0004](docs/adr/0004-two-precipitation-scoring-pipelines.md).

## Documents

| Document | Contents |
| --- | --- |
| [`CONTEXT.md`](CONTEXT.md) | Domain glossary: Forecast Location, Station Match, Capture Cohort, Effective Influence, and the rest |
| [`docs/weather-sources.md`](docs/weather-sources.md) | Provider contracts, configuration, cache behavior, failure modes, and attribution |
| [`docs/adr/`](docs/adr/) | Decision records: reliability state, Korean location selection, service-area boundary, the two scoring pipelines, and the two station gates |
| [`docs/research/`](docs/research/) | Source evidence: the SGIS boundary package's provenance, nationwide station coverage, and the elevation gate |
| [`lib/performance/README.md`](lib/performance/README.md) | The nationwide pipeline: live captures, retrospective seed evidence, and the mode gate |
| [`lib/reliability/README.md`](lib/reliability/README.md) | The single-station precipitation-scoring pipeline |

## Stack

| Area | Technology |
| --- | --- |
| App | Next.js 16, React 19, TypeScript |
| Styling | Tailwind CSS 4 and custom responsive CSS |
| Forecasts | Open-Meteo, MET Norway, KMA, Pirate Weather, WeatherAPI |
| Ground truth | KMA ASOS daily precipitation |
| Persistence | PostgreSQL via Postgres.js |
| Scheduling | GitHub Actions at fixed KST cohorts |

## Run locally

Requires Node.js 22 or later.

```bash
npm ci
install -m 600 .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Open-Meteo provides a keyless forecast baseline; configure `KAKAO_REST_API_KEY` for Korean administrative-area search and for naming a device coordinate. Optional weather providers activate when configured.

To collect regional performance, configure:

- `PERFORMANCE_DATABASE_URL`: a standard PostgreSQL connection URL;
- `KMA_APIHUB_KEY`: subscribed to the KMA surface-observation station catalog;
- `KMA_OBSERVATION_API_KEY`: subscribed to the KMA ASOS daily service;
- optional provider credentials listed in [`.env.example`](.env.example).

Then run one fixed cohort:

```bash
npm run performance:capture -- --cohort=06
```

The scheduled workflow needs the same values as GitHub Actions secrets. If the database or station catalog is unavailable, the public forecast remains usable with an explicit equal-weight/no-evidence state.

## Verification

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`npm test` runs the library suite and a JSDOM component suite. The PostgreSQL performance store is held to the same executable contract as the in-memory one, but only when a disposable database is supplied:

```bash
PERFORMANCE_STORE_CONTRACT_URL=postgres://… npm test
```

The suite truncates that database's tables, so it must never be a production URL. Without it, the PostgreSQL contract is reported as skipped rather than passing.

Manual product checks should cover:

- location permission only after the location button is pressed;
- Korea-only place search and location switching;
- desktop and narrow mobile layouts;
- equal influence when performance evidence is missing or insufficient;
- station name, distance, sample depth, and recent scores when evidence is active;
- no user coordinates in PostgreSQL performance tables.

## Limits

- Initial launch covers South Korea and precipitation only.
- Exact-coordinate admission uses the official SGIS 시도 boundary geometry, so offshore and cross-border coordinates are rejected. The geometry is simplified to a 10 m tolerance, so a decision within roughly 25 m of the coastline can differ from the unsimplified source. Manual place search remains country-filtered to Korea.
- ASOS is the first observation network. AWS eligibility remains a later audited expansion.
- Initial shadow-validation policy defaults are: station distance at most 100 km; elevation difference at most 400 m; rain at 0.1 mm; miss/false-alarm decisions at 50%; at least 30 comparable captures with both wet and dry evidence; influence ramping through 60 captures; provider influence bounded to 5–60%; and an `exp(-12 × Brier)` score transform. These values, including the one-wet-day minimum, require validation against shadow data before marketing local coverage or performance guarantees.
- A location may have no eligible observation station even when forecasts are available.
- Provider availability and forecast horizon vary; missing values are omitted, never treated as zero.
- Prospective evidence needs time to accumulate. A station begins on retrospective seed evidence where a backfill has been run, and on equal influence otherwise.
- Seed evidence uses each provider's underlying model as a proxy (ECMWF for MET Norway, GFS for Pirate Weather, KMA's own model for KMA), not the provider's published product. It is capped, labelled as retrospective, and replaced by live evidence as soon as that matures.
- The offline backfill reads the station catalog from KMA apihub `stn_inf`; without that subscription it falls back to the committed catalog in `lib/performance/stationCatalog.ts`, which must be regenerated with `npm run performance:catalog` before nationwide seeding.
- Weather information is not suitable for safety-critical decisions.

## License

Copyright (c) 2026 Michael Ju. All rights reserved.
No license is granted for use, copying, modification, or distribution of this code as of 2026-07-30. This repository is public for portfolio review purposes only.
