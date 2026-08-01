# Claude Code repository guidance

SeoulSky is a completed, Seoul-only cinematic weather project. Keep changes focused on maintenance, correctness, security, and compatibility; do not add new product scope unless explicitly requested. `README.md` is the canonical public overview.

## Working standard

Use the repository-contained architecture, invariants, code conventions, and
documentation guidance in this file when working in SeoulSky.

## Runtime and commands

- Node 22 or newer; npm with the committed `package-lock.json`.
- `npm run dev` — local server at `http://localhost:3000/sky`.
- `npm run lint` — ESLint.
- `npx tsc --noEmit` — strict TypeScript check.
- `npm test` — Node's native test runner over `lib/**/*.test.ts`.
- `npm run build` — production build; `next/font` needs network access to fetch Geist and Noto Sans KR during a clean build.

The application works without environment variables. Copy `.env.example` to `.env.local` only to enable optional server-side providers. Never expose provider keys through `NEXT_PUBLIC_*`, logs, errors, fixtures, or responses.

## Architecture

- `/` redirects to `/sky`; `/atmosphere` and `/diagnostics` redirect there through `next.config.ts`.
- `app/sky/layout.tsx` mounts the persistent `WeatherExperienceShell`; `app/sky/page.tsx` renders `SkyView`.
- `/api/sky` is the lean live-scene payload. Open-Meteo is the keyless baseline; optional KMA, AirKorea, and RainViewer data degrade independently.
- `/api/weather` is the deferred, heavier provider-comparison payload used by Ground Station.
- `/api/radar/frames` and `/api/radar/frame` are thin adapters over `RadarDelivery`, serving optional KMA reflectivity metadata and server-rendered PNG frames. `RadarDelivery` owns key/window validation, newest-frame readiness, bounded process-local admission, same-key single-flight, cancellation, and recent immutable PNG caching; KMA keys and raw grids must never reach the client.
- Forecast providers use `WeatherProvider.read()` to return one Provider Snapshot: availability, cache freshness, and normalized current, hourly, and daily weather from the same cached generation. The live Sky snapshot, Weather Intelligence, runtime precipitation collection, and scheduled forecast log reuse this boundary.
- `lib/cache.ts` provides process-local single-flight TTL caching with stale-on-error fallback.
- `public/sky/manifest.json` is the runtime still-image manifest. The live scene does not use a video gallery.

## Invariants

- Keep Seoul time calculations pinned to `Asia/Seoul`; never use the browser timezone for weather or sun-phase decisions.
- Preserve `/api/sky` and `/api/weather` response contracts unless the consuming components and documentation change together.
- Preserve the Provider Snapshot boundary: status/cache freshness and weather must come from one provider read. Reuse the shared provider cache; omit non-OK or target-date-missing sources from consensus and forecast logs rather than fabricating values. Stale last-good snapshots remain available with their matching weather.
- Preserve forecast-provider order: Open-Meteo, MET Norway, KMA, Pirate Weather, then WeatherAPI. The first available current snapshot remains the comparison primary.
- Preserve the RadarDelivery boundary: allow only real five-minute keys in the recent observed window; keep its default per-process limit of two active renders and eight queued renders; coalesce same-key requests; and propagate cancellation. Its newest-frame timeline probe is a readiness check only, not a promise that other frames are cached. Keep produced PNGs immutable, process-local cache entries defensive and window-pruned, and failure responses non-cacheable.
- Do not move per-second clock state into `WeatherFieldProvider`; that would repaint the scene every second.
- Raw weather values must pass through the clamped visual mapping in `lib/atmosphere/weatherVisualConfig.ts` before reaching the shader.
- A clear or partly-cloudy sky must never select a rain or snow plate. Time anchor is the hard axis in `lib/cinematic/skyImageField.ts`.
- Missing providers, images, WebGL, or radar must leave an honest fallback rather than a blank scene or fabricated value.
- Preserve required attribution for KMA, CARTO/OpenStreetMap, RainViewer, Open-Meteo, and MET Norway.

## Code conventions

- Test-reachable `lib/**` modules use explicit `.ts` extensions for relative imports so Node can run TypeScript tests directly. Next.js app/component imports use the `@/` alias.
- The scoped ESLint exceptions for imperative WebGL/ref loops are intentional. Do not broaden them.
- The radar's raw `<img>` tiles are intentional because exact percentage positioning is required.
- Radar warm-up must remain progressive: request one frame at a time in active/playback order, record failures, skip failed frames for display/playback, and retain circular playback.
- The development-only visual override is `/sky?cond=<condition>&hour=<0-23>`; it must remain inert in production.
- Reliability records under `data/reliability/` are currently tracked and published on `main`; a later dedicated plan will migrate them atomically. Radar cache output under `data/radar/` is ignored and must not be committed.

## Documentation

- `README.md` — public setup, architecture, screenshots, status, and limitations.
- `docs/weather-sources.md` — provider contracts and attribution.
- `lib/reliability/README.md` — scheduled precipitation-scoring pipeline.

Update these documents when their corresponding behavior changes. Do not add session handoffs, temporary plans, dated test counts, private machine paths, or personal prompting conventions to the repository.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for this repository. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the default five-role triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `CONTEXT.md` and `docs/adr/` when needed. See `docs/agents/domain.md`.
