# Weather and environment sources

오늘비 accepts validated coordinates inside the supported South Korea service area and uses `Asia/Seoul`. Exact-coordinate validation tests the coordinate against official SGIS 시도 boundary geometry, so sea and cross-border coordinates are rejected; see [`docs/research/sgis-boundary-acquisition.md`](./research/sgis-boundary-acquisition.md) for the source package, terms, boundary vintage, and update procedure. The geometry is generated offline into a server-only asset and is never sent to the browser. On a cache miss, forecast providers receive the submitted coordinate. Process-local provider caches use a truncated SHA-256 digest of the complete validated numeric coordinate: raw coordinates do not appear in cache keys, and distinct coordinates do not intentionally share provider snapshots. This preserves the Forecast Location contract instead of quantizing one user's response onto another user's coordinate. The exact coordinate also determines the request's KMA grid and observation-station match. The local-performance collector separately requests forecasts at official KMA ASOS coordinates. All upstream calls run on the server. Provider keys, database credentials, and the MET Norway contact-bearing user agent must never be returned to the browser or written to logs.

The application remains usable without weather-provider keys: Open-Meteo supplies weather and air quality, and RainViewer supplies the conservative rain-approach signal. Manual administrative-area search requires a server-side Kakao REST key, which is also what resolves a device coordinate to its 시·구·동 name; browser current-location selection remains available without it, under the generic "현재 위치" label. Optional weather sources enrich the response and fail independently.

| Source | Purpose | Configuration | Cache | Failure behavior |
| --- | --- | --- | --- | --- |
| Open-Meteo Forecast | Current, hourly, and seven-day baseline at the requested coordinate | None | 5 min per location | Expired cache, then route-level 503 |
| Kakao Map Local REST | Korean administrative-area search (one row per place, 행정동 name leading and 법정동 alongside), WGS84 resolution, and reverse geocoding of a device coordinate | `KAKAO_REST_API_KEY` | HTTP response cache 5 min | Search route returns 503 `search_not_configured` when unkeyed, so the client offers no retry; reverse geocoding degrades to the "현재 위치" placeholder |
| Open-Meteo Air Quality | Keyless PM, gases, aerosol, and UV baseline | None | 20 min | Air quality becomes `null` |
| MET Norway | Provider comparison | `MET_NO_USER_AGENT` with contact | 15 min | Provider reports `needs-config` or `error` |
| KMA short-term | Forecast comparison at the requested KMA grid | `KMA_SHORT_TERM_API_KEY` | 5 min per location | Source is omitted from the current blend |
| KMA ASOS station catalog | Active station coordinates and elevations for performance collection | `KMA_APIHUB_KEY` with station-information access | Refreshed by each fixed cohort | Collector fails visibly rather than using a fabricated catalog |
| KMA ASOS daily observation | Completed station-day precipitation ground truth | `KMA_OBSERVATION_API_KEY` | Durable PostgreSQL row | Missing station-day observation is not scored |
| KMA warnings | Official active warnings | `KMA_WARNING_API_KEY` | 5 min | Warnings become `[]` |
| KMA API Hub radar | Displayed HSR reflectivity frames | `KMA_APIHUB_KEY` | Recent PNGs in a process-local `RadarDelivery` cache; successful immutable frame responses are browser/CDN-cacheable for 1 day | Timeline becomes an explicit empty state when not ready; an invalid frame is rejected, a full render queue is temporarily busy, and an unavailable render fails without exposing the key |
| AirKorea | Preferred measured air quality | `AIRKOREA_API_KEY` | 20 min | Open-Meteo air quality remains |
| Pirate Weather | Optional provider comparison and precipitation consensus | `PIRATE_WEATHER_API_KEY` | 5 min | Source is omitted |
| WeatherAPI | Optional provider comparison and precipitation consensus | `WEATHERAPI_KEY` | 5 min | Source is omitted |
| RainViewer | Keyless precipitation-approach signal only | None | 10 min | Approach signal becomes `null` |

`lib/cache.ts` provides process-local TTL caching with single-flight refreshes. If a refresh fails and an expired value exists, the provider serves that value with `stale: true`. This is an availability fallback, not durable storage; serverless instances do not share it.

Learned reliability uses a separate durable path. The daily transaction publishes its exact three-file manifest to the public `reliability-state` Git branch; release branches do not track those outputs.

The web runtime fetches only the learned weights from raw GitHub and schema-validates them. Missing or invalid state falls back to equal weights. Vercel deployments are disabled for state-branch commits.

Nationwide recent performance uses PostgreSQL rather than Git as its primary store. `performance_stations` contains official observation-station metadata; `performance_captures` contains one immutable next-day provider capture per station/date/cohort; and `performance_observations` contains one correctable official station-day result. These tables never store a user query, browser identifier, or user coordinate. The 06 and 18 KST scheduled cohorts are kept separate, and retries preserve the first capture for a station/date/cohort.

Radar uses a separate `RadarDelivery` boundary rather than `lib/cache.ts`. It accepts only real five-minute KST keys in the current 90-minute observed window. Timeline discovery starts at the nominal newest key and scans backward in five-minute steps through at most seven candidates; it continues only after an explicitly classified not-yet-published result. The first deliverable key anchors all 13 oldest-to-newest observed frames. Busy admission, cancellation, timeout, malformed data, and terminal upstream failures stop discovery and return an empty timeline. Discovery does not render the remaining playback frames or guarantee later process-local cache hits. Per process, delivery admits at most two renders and queues at most eight more; same-key requests share one render, and queued or unneeded work can be cancelled. Ready PNG bytes are defensively copied into a process-local cache and pruned outside the allowed window. This cache is not shared or durable. A successfully produced immutable frame response is separately public-cacheable for one day by the browser/CDN. Frame responses distinguish invalid input (400), admission pressure (503 with delivery-owned `Retry-After`), cancellation (499), and unavailable rendering (502), all without caching the failure.

The browser has one status-aware radar-frame loader. It prioritizes the active frame, then the next circular playback frame, keeps at most one fetch/decode lifecycle in flight, and aborts obsolete work after seeking, timeline replacement, or unmount. Successful PNG responses become decoded blob URLs before they can be displayed, so the visible image never creates an independent frame-route request. Temporary 429/503 pressure honors `Retry-After` with a three-attempt batch plus one cancellable re-entry batch (six automatic attempts maximum and a 60-second delay cap). Exhausted transient pressure pauses playback and remains retryable with Play; HTTP/decode/visible-image terminal failures are recorded and skipped honestly. Playback advances only onto decoded frames.

Each forecast provider exposes one Provider Snapshot read. Its availability, cache/freshness metadata, and normalized current, hourly, and daily weather come from the same cached generation. The shared provider instance and its ID-keyed cache are reused by the Sky snapshot assembler and its runtime precipitation collection — both retained but no longer served — and by scheduled forecast logging, which is live. A missing configuration or failed fetch yields an empty non-OK snapshot; stale last-good data stays an available snapshot with `stale: true`.

## Fusion rules

- `/api/local-forecast` requests every forecast provider at the validated Forecast Location and targets the next KST calendar day.
- The hero's time-of-day precipitation strip is **not** blended. It comes from the first provider in registry order that publishes an hourly series, and the page names that provider alongside it. Hourly series differ between providers in issue time, resolution and what counts as precipitation, so averaging them would produce a curve none of them issued. The headline probability beside it remains the multi-provider blend.
- Its Recent Performance Profile comes from the ASOS Station Match that passes the configured distance and elevation gates. The API returns the station name and distance rather than presenting station evidence as exact-coordinate truth.
- Probability performance uses all completed wet and dry days in a 30-day lookback with a 14-day half-life. Rainy-day amount MAE is separate.
- Learned influence requires comparable sample, wet-day, and dry-day evidence; then it ramps and remains bounded by provider floors and caps.
- Shadow-validation defaults are a 100 km station-distance gate, 400 m elevation-difference gate, 0.1 mm rain threshold, 50% decision threshold, 30-to-60-capture influence ramp, 5–60% provider bounds, and an `exp(-4 × Brier)` score transform. The initial wet-evidence minimum is one rainy day. These are operating defaults to validate, not coverage or accuracy guarantees.
- The Prospective Benchmark freezes adaptive and equal outputs at capture time and later scores them on identical completed rows. Regression or insufficient benchmark evidence suspends learned influence.
- Missing current providers are omitted and the remaining current weights renormalize. Missing performance evidence selects equal influence; it never becomes a numeric zero score.
- Recent Performance Profile influence applies only to the measured next-day horizon. Days 2–7 use equal influence until separately captured prospective evidence exists for those lead times.

The Sky snapshot assembler (`lib/liveSkySnapshot.ts`, `lib/skyFusion.ts`) is **retained but no longer served**: `/api/sky` was deleted on 2026-08-22, and `/api/weather` went with it along with the comparison assembler behind it. The rules in the next block therefore describe module behaviour, not a live response.

- The assembler uses Open-Meteo as the complete baseline.
- `chooseCurrent()` prefers KMA temperature and active precipitation when a valid KMA observation is available. It only adopts KMA's condition when KMA reports active precipitation, because the observation feed does not provide complete dry-sky cloud semantics.
- Air quality uses AirKorea, then Open-Meteo, then `null`.
- Warnings come only from KMA. Forecast probability never creates a warning.
- Daily precipitation fields use the gated learned multi-provider consensus documented in `lib/reliability/README.md` by default. Set `MULTI_SOURCE_PRECIP=0` only as an emergency opt-out to the single Open-Meteo baseline.
- Learned weights come from the public `reliability-state` branch; forecast and skill history never enter an API response.

These remain live:

- Displayed radar imagery comes from KMA API Hub, served by `/api/radar/*`. RainViewer remains a separate approach signal and never supplies the displayed map.
- Scheduled forecast logging projects daily data only from available snapshots. A non-OK provider or a missing target date is omitted, never represented as a made-up forecast. The same rule governs the assembler's runtime precipitation collection, which is retained but no longer served.
- Forecast-provider order remains Open-Meteo, MET Norway, KMA, Pirate Weather, then WeatherAPI. The first available current snapshot in that order is the comparison primary.

## Attribution

The UI must retain the applicable credits: Kakao Map for administrative search; Open-Meteo; MET Norway; 기상청 (KMA); AirKorea; Pirate Weather; WeatherAPI; RainViewer; and © CARTO / © OpenStreetMap for the radar basemap. The service-area geometry is derived from 국가데이터처 SGIS 행정구역 경계, published with no stated usage restriction; it is used server-side only and no boundary geometry is displayed. Check provider terms before changing commercial use, caching, or redistribution behavior.

Kakao is credited in **plain text only, and deliberately so**. Kakao Developers site terms 11-10 prohibit using Kakao trademarks or logos without explicit consent, and Kakao states that Local API search results require no source attribution or branding at all — the logo guidance applies to the Kakao Map SDK, which this project does not use. Adding a Kakao logo would move the project from compliant to non-compliant.

Kakao Local search is **live call only**. Site terms 11-3 bar replicating API results without prior approval, and Kakao's Maps team treats a cache kept to reduce request frequency as a temporary database that their operating policy forbids, explicitly including a one-hour cache. `/api/locations/search` therefore answers `no-store` and nothing about a Kakao response is persisted. The daily quota is 100,000 requests per app, far above this project's traffic, so there is no pressure to revisit that. Serving Local results alongside a non-Kakao basemap is permitted; Kakao does not restrict use with third-party APIs.

## Implementation map

- Forecast-location validation and KMA grid conversion: `lib/location.ts`
- Service-area containment and its generated geometry: `lib/locationServiceArea.ts`, `lib/locationServiceAreaData.ts`, `scripts/generate-service-area.ts`
- Korea-only manual search: `lib/locationSearch.ts`, `app/api/locations/search/route.ts`
- Exact-location forecast assembly: `lib/localForecast.ts`, `app/api/local-forecast/route.ts`
- Effective Influence and the blend it produces: `lib/performance/influence.ts`
- The flat page contract `/api/local-forecast` returns: `lib/localForecastView.ts`
- Recent performance scoring and station matching: `lib/performance/performance.ts`, `lib/performance/stations.ts`
- Performance persistence, capture, and fixed-cohort batch: `lib/performance/store.ts`, `lib/performance/postgres.ts`, `lib/performance/capture.ts`, `lib/performance/batch.ts`, `scripts/local-performance.ts`
- Store adapter contract, run against every persistence adapter: `lib/performance/storeContract.ts`
- The separate single-station scoring pipeline, deliberately not merged with the above: `lib/reliability/*`, [`docs/adr/0004-two-precipitation-scoring-pipelines.md`](./adr/0004-two-precipitation-scoring-pipelines.md). Its own HTTP path is gone with `/api/sky`, and it now runs only from the scheduled job — but it is not fully unreachable: `lib/reliability/score.ts` supplies the seed scoring that `lib/performance/seedScore.ts` uses on the served path.

- Provider contract, atomic snapshot factory, and registry: `lib/providers/base.ts`, `lib/providers/read.ts`, `lib/providers/registry.ts`
- Provider implementations: `lib/providers/*`
- Fusion, retained but no longer served: `lib/skyFusion.ts`, `lib/liveSkySnapshot.ts`, `lib/liveSkySnapshot.production.ts`
- Comparison: `lib/compare.ts`. Only `rainRiskNext12h` still has a caller; `buildComparison` and `buildConfidence` lost theirs when `lib/weatherIntelligence.ts` was deleted.
- Radar delivery and rendering: `lib/radar/kma.ts` owns pure KST keys plus sanitized KMA source classification; `lib/radar/delivery.ts` owns window validation, newest-deliverable discovery, bounded admission, same-key single-flight, cancellation, and immutable PNG caching; `lib/radar/apihub.ts` supplies KMA bounds/rendering; `lib/radar/http.ts` maps delivery results; and `app/api/radar/*` are rate-limited HTTP adapters.
- Radar browser loading: `lib/radar/clientLoader.ts` owns sequential fetch/decode state, backpressure retries, cancellation, and blob-URL lifecycle; `lib/radar/presentation.ts` owns pure ordering/playback helpers; `components/atmosphere/sections/RadarSection.tsx` renders only controller-ready frames.
- Shared cache: `lib/cache.ts`

The application does not authenticate users, store profiles, or accept uploads. It persists official station metadata, prospective forecast captures, and KMA observations in PostgreSQL; it does not persist user coordinates.
