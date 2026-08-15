# Claude Code repository guidance

SeoulSky is a completed, Seoul-only cinematic weather project. Keep changes focused on maintenance, correctness, security, and compatibility; do not add new product scope unless explicitly requested. `README.md` is the canonical public overview.

## Runtime and commands

- Node 22 or newer; npm with the committed `package-lock.json`.
- `npm run dev` — local server at `http://localhost:3000/sky`.
- `npm run lint` — ESLint.
- `npx tsc --noEmit` — strict TypeScript check.
- `npm test` — Node's native runner over `lib/**/*.test.ts`, then the focused TSX/JSDOM component suite.
- `npm run build` — production build; `next/font` needs network access to fetch Geist and Noto Sans KR during a clean build.

The application works without environment variables. Copy `.env.example` to `.env.local` only to enable optional server-side providers. Never expose provider keys through `NEXT_PUBLIC_*`, logs, errors, fixtures, or responses.

## Architecture

- `/` redirects to `/sky`; `/atmosphere` and `/diagnostics` redirect there through `next.config.ts`.
- `app/sky/layout.tsx` mounts the persistent `WeatherExperienceShell`; `app/sky/page.tsx` renders `SkyView`.
- `/api/sky` is the lean live-scene payload. Open-Meteo is the keyless baseline; optional KMA, AirKorea, and RainViewer data degrade independently.
- `/api/weather` is the deferred, heavier provider-comparison payload used by Ground Station.
- `/api/radar/frames` and `/api/radar/frame` are thin adapters over `RadarDelivery`, serving optional KMA reflectivity metadata and server-rendered PNG frames. `RadarDelivery` owns key/window validation, bounded newest-deliverable discovery, process-local admission, same-key single-flight, cancellation, and recent immutable PNG caching; KMA keys and raw grids must never reach the client.
- Forecast providers use `WeatherProvider.read()` to return one Provider Snapshot: availability, cache freshness, and normalized current, hourly, and daily weather from the same cached generation. The live Sky snapshot, Weather Intelligence, runtime precipitation collection, and scheduled forecast log reuse this boundary.
- `lib/cache.ts` provides process-local single-flight TTL caching with stale-on-error fallback.
- The scheduled reliability CLI delegates restore, optional recovery, isolated cycle execution, validation, and publication to `runReliabilityStateTransaction`.
- `GitStateTarget` owns the public `reliability-state` branch. The web runtime reads only its raw learned-weights file; `vercel.json` prevents state commits from creating deployments.
- `public/sky/manifest.json` is the runtime still-image manifest. The live scene does not use a video gallery.

## Invariants

- Keep Seoul time calculations pinned to `Asia/Seoul`; never use the browser timezone for weather or sun-phase decisions.
- Preserve `/api/sky` and `/api/weather` response contracts unless the consuming components and documentation change together.
- Validate every forecast coordinate against the generated service-area geometry before KMA grid conversion or any provider request. Keep that geometry server-only, regenerate it only from the official SGIS package with `scripts/generate-service-area.ts`, and re-verify the island corpus whenever it is regenerated. Never commit the raw boundary package.
- Preserve the Provider Snapshot boundary: status/cache freshness and weather must come from one provider read. Reuse the shared provider cache; omit non-OK or target-date-missing sources from consensus and forecast logs rather than fabricating values. Stale last-good snapshots remain available with their matching weather.
- Preserve forecast-provider order: Open-Meteo, MET Norway, KMA, Pirate Weather, then WeatherAPI. The first available current snapshot remains the comparison primary.
- Preserve the RadarDelivery boundary: allow only real five-minute keys in the recent observed window; keep its default per-process limit of two active renders and eight queued renders; coalesce same-key requests; and propagate cancellation. Timeline discovery may scan from the nominal newest key through six older five-minute keys only while KMA explicitly classifies candidates as not yet published; the first deliverable key anchors all 13 frames. Busy, cancelled, timeout, malformed, and terminal failures stop discovery. Discovery is not a promise that other frames are cached. Keep produced PNGs immutable, process-local cache entries defensive and window-pruned, delivery-owned busy retry metadata serialized by the HTTP adapter, and failure responses non-cacheable.
- Do not move per-second clock state into `WeatherFieldProvider`; that would repaint the scene every second.
- Raw weather values must pass through the clamped visual mapping in `lib/atmosphere/weatherVisualConfig.ts` before reaching the shader.
- A clear or partly-cloudy sky must never select a rain or snow plate. Time anchor is the hard axis in `lib/cinematic/skyImageField.ts`.
- Missing providers, images, WebGL, or radar must leave an honest fallback rather than a blank scene or fabricated value.
- Preserve required attribution for KMA, CARTO/OpenStreetMap, RainViewer, Open-Meteo, and MET Norway.

## Code conventions

- Test-reachable `lib/**` modules use explicit `.ts` extensions for relative imports so Node can run TypeScript tests directly. Next.js app/component imports use the `@/` alias.
- The scoped ESLint exceptions for imperative WebGL/ref loops are intentional. Do not broaden them.
- The radar's raw `<img>` tiles are intentional because exact percentage positioning is required.
- Radar warm-up must remain progressive and controller-owned: keep one abortable fetch/decode lifecycle in flight, prioritize active then next playback frame, render only decoded blob URLs, gate autoplay on readiness, retry bounded 429/503 pressure without marking it terminal, capture visible-image failures, revoke owned URLs, skip terminal failures, and retain circular playback.
- The development-only visual override is `/sky?cond=<condition>&hour=<0-23>`; it must remain inert in production.
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
