# Claude Code repository guidance

오늘비 is a South Korea local rain forecast: it compares next-day precipitation at a validated user coordinate and can weight providers by recently observed performance at a nearby KMA ASOS station. It grew out of a Seoul-only cinematic weather scene; that scene is retired and unrouted, and nothing renders behind the forecast. Keep changes focused on maintenance, correctness, security, and compatibility; do not add new product scope unless explicitly requested. `README.md` is the canonical public overview and `CONTEXT.md` is the domain glossary.

## Runtime and commands

- Node 22 or newer; npm with the committed `package-lock.json`.
- `npm run dev` — local server at `http://localhost:3000`.
- `npm run lint` — ESLint.
- `npx tsc --noEmit` — strict TypeScript check.
- `npm test` — Node's native runner over `lib/**/*.test.ts`, then the focused TSX/JSDOM component suite.
- `npm run build` — production build; `next/font` needs network access to fetch Geist and Noto Sans KR during a clean build.

The application works without environment variables. Copy `.env.example` to `.env.local` only to enable optional server-side providers. Never expose provider keys through `NEXT_PUBLIC_*`, logs, errors, fixtures, or responses.

## Architecture

- `app/page.tsx` renders `LocalForecastExperience` — the location chooser and, once a coordinate is chosen, the forecast dashboard — plus the `<noscript>` notice. It carries no `metadata` export; the root layout owns the title and description.
- `/atmosphere` and `/diagnostics` redirect to `/` through `next.config.ts`. No other route is served; unknown paths 404.
- The dashboard is one vertical read with no ambient scene behind it: the rain window as a sentence, the horizontal 24-hour ribbon (eight 3-hour blocks), the 오늘 / 내일 cards, three evidence cards, then the scored per-provider table. Its only interactive control is "위치 바꾸기".
- The chooser, the loading overlay, and the failure card share that vocabulary: one flat ground, mono meta, 3px corners, and the rain-blue accent as the only filled colour. Nothing on any of the four screens may reintroduce the retired teal palette.
- `components/atmosphere/` (`SkyView`, the still-image field, `WeatherExperienceShell`) is no longer routed **and its data endpoints are gone**: `/api/sky` and `/api/weather` were deleted on 2026-08-22, so `useLiveSeoulWeather` and `GroundStationSection` now fetch paths that 404. `RadarSection` is the exception — its `/api/radar/*` endpoints are intact and stay so (next bullet). The tree is kept, not deleted; re-routing the scene would mean rebuilding the deleted endpoints as well as restoring the archived plates, and neither should happen without being asked.
- `/api/radar/frames` and `/api/radar/frame` are thin adapters over `RadarDelivery`, serving optional KMA reflectivity metadata and server-rendered PNG frames. **They are deliberately orphaned.** Their only caller is `RadarSection` in the unrouted `components/atmosphere/`, so nothing served has fetched them since the redesign — measured 2026-08-23, zero requests and zero `apihub.kma.go.kr` calls over 12 hours. They are kept because the radar is intended to return to the product (#69); do not delete them, and do not conclude from the silence that they are dead code. `RadarDelivery` owns key/window validation, bounded newest-deliverable discovery, process-local admission, same-key single-flight, cancellation, and recent immutable PNG caching; KMA keys and raw grids must never reach the client.
- Forecast providers use `WeatherProvider.read()` to return one Provider Snapshot: availability, cache freshness, and normalized current, hourly, and daily weather from the same cached generation. The live Sky snapshot assembler, runtime precipitation collection, and scheduled forecast log reuse this boundary.
- `lib/cache.ts` provides process-local single-flight TTL caching with stale-on-error fallback.
- The scheduled reliability CLI delegates restore, optional recovery, isolated cycle execution, validation, and publication to `runReliabilityStateTransaction`.
- `GitStateTarget` owns the public `reliability-state` branch. Nothing served reads it any more — the raw learned-weights file was read only through `/api/sky`, so the daily job now publishes state that no route consumes. It keeps running anyway until the 2026-09-18 revisit in ADR 0007; `vercel.json` prevents state commits from creating deployments.
- `public/sky/` is gone. The 37 still-image plates and their manifest were archived out of the repo on 2026-08-19 once the redesign left them with no consumer; they remain in git history and in the owner's local archive. `components/atmosphere/scene/SkyImageContext.tsx` still fetches `/sky/manifest.json`, so that tree cannot be re-routed without restoring the assets first.

## Invariants

- Keep Seoul time calculations pinned to `Asia/Seoul`; never use the browser timezone for weather or sun-phase decisions.
- Validate every forecast coordinate against the generated service-area geometry before KMA grid conversion or any provider request. Keep that geometry server-only, regenerate it only from the official SGIS package with `scripts/generate-service-area.ts`, and re-verify the island corpus whenever it is regenerated. Never commit the raw boundary package.
- Preserve the Provider Snapshot boundary: status/cache freshness and weather must come from one provider read. Reuse the shared provider cache; omit non-OK or target-date-missing sources from consensus and forecast logs rather than fabricating values. Stale last-good snapshots remain available with their matching weather.
- Preserve the seed evidence boundary. Retrospective Seed Comparisons are scored on amount, stored in their own table, and carry no cohort and no frozen blend, so they can never reach the Prospective Benchmark. Seed influence stays capped, never rescues a benchmark suspension, and is superseded entirely once live evidence matures. Never seed a provider that has no honest archive proxy, and never hand-edit `lib/performance/stationCatalog.ts` — regenerate it with `npm run performance:catalog`.
- Preserve forecast-provider order: Open-Meteo, MET Norway, KMA, Pirate Weather, then WeatherAPI. The first available current snapshot remains the comparison primary.
- Preserve the RadarDelivery boundary — the invariants below still bind even though no served route exercises them today: allow only real five-minute keys in the recent observed window; keep its default per-process limit of two active renders and eight queued renders; coalesce same-key requests; and propagate cancellation. Timeline discovery may scan from the nominal newest key through six older five-minute keys only while KMA explicitly classifies candidates as not yet published; the first deliverable key anchors all 13 frames. Busy, cancelled, timeout, malformed, and terminal failures stop discovery. Discovery is not a promise that other frames are cached. Keep produced PNGs immutable, process-local cache entries defensive and window-pruned, delivery-owned busy retry metadata serialized by the HTTP adapter, and failure responses non-cacheable.
- Do not move per-second clock state into `WeatherFieldProvider`; that would repaint the scene every second.
- Raw weather values must pass through the clamped visual mapping in `lib/atmosphere/weatherVisualConfig.ts` before reaching the shader.
- A clear or partly-cloudy sky must never select a rain or snow plate. Time anchor is the hard axis in `lib/cinematic/skyImageField.ts`. (Unrouted, and its plates are no longer in the repo; the rule holds for the code, which is still tested on synthetic fixtures.)
- The ribbon's bars are a plain 0–100% scale with the umbrella threshold drawn at the probability it names — never a compressed scale that would put the mark somewhere other than its own value. A block with no published probability is hatched and unfilled; a published 0% keeps a real, thin bar. The rain window comes from `readTimeline`, and an unpublished block ends a run rather than extending it, so the page claims an end time only when a later block proved one.
- The ribbon is one provider's hourly series while the 오늘 / 내일 numbers are a multi-provider blend. Keep them attributed apart; never let the ribbon read as consensus. Performance weighting applies to tomorrow only.
- Missing providers, images, WebGL, or radar must leave an honest fallback rather than a blank scene or fabricated value.
- The two failure shapes stay distinct: `retry` is null exactly when the same request can never succeed, and that card must offer no retry. The loading screen may name the providers being contacted but must never claim per-provider progress — `/api/local-forecast` answers once, so any such row would be invented.
- `COMPARED_PROVIDER_NAMES` and `VERIFICATION_STATION_COUNT` are what the chooser asserts before anyone commits a coordinate. The station count is a literal because the generated catalog must not reach the client bundle; a test pins it to `FALLBACK_STATION_CATALOG.length`.
- Preserve required attribution for KMA, CARTO/OpenStreetMap, RainViewer, Open-Meteo, and MET Norway.

## Code conventions

- Test-reachable `lib/**` modules use explicit `.ts` extensions for relative imports so Node can run TypeScript tests directly. Next.js app/component imports use the `@/` alias.
- The scoped ESLint exceptions for imperative WebGL/ref loops are intentional. Do not broaden them.
- The radar's raw `<img>` tiles are intentional because exact percentage positioning is required.
- Radar warm-up must remain progressive and controller-owned: keep one abortable fetch/decode lifecycle in flight, prioritize active then next playback frame, render only decoded blob URLs, gate autoplay on readiness, retry bounded 429/503 pressure without marking it terminal, capture visible-image failures, revoke owned URLs, skip terminal failures, and retain circular playback.
- The development-only visual override `?cond=<condition>&hour=<0-23>` belongs to `WeatherExperienceShell` in the unrouted `components/atmosphere/` tree, so no served route honours it today. It must remain inert in production if that tree is ever re-routed.
- Release branches ignore generated reliability JSON/JSONL. Durable state belongs only on `reliability-state`; preserve its exact three-file manifest (plus the root `vercel.json` deployment guard the branch carries) and compare-and-swap publication boundary.
- Radar cache output under `data/radar/` is ignored and must not be committed.

## Documentation

- `README.md` — public setup, architecture, screenshots, status, and limitations.
- `docs/weather-sources.md` — provider contracts and attribution.
- `lib/reliability/README.md` — scheduled precipitation-scoring pipeline.

Update these documents when their corresponding behavior changes. Do not add session handoffs, temporary plans, dated test counts, private machine paths, or personal prompting conventions to the repository.

## Licensing

This repository is deliberately all-rights-reserved: `package.json` declares `UNLICENSED` and there is no `LICENSE` file. An earlier MIT license was added and then reverted in `0e8f7c7` ("Remove MIT license, reserve all rights", 2026-07-31) — do not reintroduce one. The repository is public for portfolio review only.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for this repository. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the default five-role triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `CONTEXT.md` and `docs/adr/` when needed. See `docs/agents/domain.md`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
