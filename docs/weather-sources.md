# Weather and environment sources

SeoulSky accepts validated coordinates inside the configured South Korea launch bounds and uses `Asia/Seoul`. Exact-coordinate validation currently uses a bounding box rather than an administrative-border polygon; Korea-filtered manual search is stricter than browser-coordinate admission. Forecast providers receive the user's submitted coordinate for the current request. The local-performance collector separately requests forecasts at official KMA ASOS coordinates. All upstream calls run on the server. Provider keys, database credentials, and the MET Norway contact-bearing user agent must never be returned to the browser or written to logs.

The application is usable without keys: Open-Meteo supplies weather and air quality, and RainViewer supplies the conservative rain-approach signal. Optional sources enrich the response and fail independently.

| Source | Purpose | Configuration | Cache | Failure behavior |
| --- | --- | --- | --- | --- |
| Open-Meteo Forecast | Current, hourly, and seven-day baseline at the requested coordinate | None | 5 min per location | Expired cache, then route-level 503 |
| Open-Meteo Geocoding | Korea-filtered manual place search | None | HTTP response cache 5 min | Search route returns 503; precise browser location remains available |
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

Each forecast provider exposes one Provider Snapshot read. Its availability, cache/freshness metadata, and normalized current, hourly, and daily weather come from the same cached generation. The shared provider instance and its ID-keyed cache are reused by the live Sky snapshot, deferred Weather Intelligence comparison, runtime precipitation collection, and scheduled forecast logging. A missing configuration or failed fetch yields an empty non-OK snapshot; stale last-good data stays an available snapshot with `stale: true`.

## Fusion rules

- `/api/local-forecast` requests every forecast provider at the validated Forecast Location and targets the next KST calendar day.
- Its Recent Performance Profile comes from the ASOS Station Match that passes the configured distance and elevation gates. The API returns the station name and distance rather than presenting station evidence as exact-coordinate truth.
- Probability performance uses all completed wet and dry days in a 30-day lookback with a 14-day half-life. Rainy-day amount MAE is separate.
- Learned influence requires comparable sample, wet-day, and dry-day evidence; then it ramps and remains bounded by provider floors and caps.
- Shadow-validation defaults are a 100 km station-distance gate, 400 m elevation-difference gate, 0.1 mm rain threshold, 50% decision threshold, 30-to-60-capture influence ramp, 5–60% provider bounds, and an `exp(-4 × Brier)` score transform. The initial wet-evidence minimum is one rainy day. These are operating defaults to validate, not coverage or accuracy guarantees.
- The Prospective Benchmark freezes adaptive and equal outputs at capture time and later scores them on identical completed rows. Regression or insufficient benchmark evidence suspends learned influence.
- Missing current providers are omitted and the remaining current weights renormalize. Missing performance evidence selects equal influence; it never becomes a numeric zero score.
- Recent Performance Profile influence applies only to the measured next-day horizon. Days 2–7 use equal influence until separately captured prospective evidence exists for those lead times.

- `/api/sky` uses Open-Meteo as the complete baseline.
- `chooseCurrent()` prefers KMA temperature and active precipitation when a valid KMA observation is available. It only adopts KMA's condition when KMA reports active precipitation, because the observation feed does not provide complete dry-sky cloud semantics.
- Air quality uses AirKorea, then Open-Meteo, then `null`.
- Warnings come only from KMA. Forecast probability never creates a warning.
- Displayed radar imagery comes from KMA API Hub. RainViewer remains a separate approach signal and never supplies the displayed map.
- Daily precipitation fields use the gated learned multi-provider consensus documented in `lib/reliability/README.md` by default. Set `MULTI_SOURCE_PRECIP=0` only as an emergency opt-out to the single Open-Meteo baseline.
- Learned weights come from the public `reliability-state` branch; forecast and skill history never enter an API response.
- `/api/weather` compares every configured provider that returns a valid current snapshot. Missing measurements are excluded, never treated as zero.
- Runtime precipitation collection and scheduled forecast logging project daily data only from available snapshots. A non-OK provider or a missing target date is omitted, never represented as a made-up forecast.
- Forecast-provider order remains Open-Meteo, MET Norway, KMA, Pirate Weather, then WeatherAPI. The first available current snapshot in that order is the comparison primary.

## Attribution

The UI must retain the applicable credits: Open-Meteo; MET Norway; 기상청 (KMA); AirKorea; Pirate Weather; WeatherAPI; RainViewer; and © CARTO / © OpenStreetMap for the radar basemap. Check provider terms before changing commercial use, caching, or redistribution behavior.

## Implementation map

- Forecast-location validation and KMA grid conversion: `lib/location.ts`
- Korea-only manual search: `lib/locationSearch.ts`, `app/api/locations/search/route.ts`
- Exact-location forecast assembly: `lib/localForecast.ts`, `app/api/local-forecast/route.ts`
- Recent performance scoring and station matching: `lib/performance/performance.ts`, `lib/performance/stations.ts`
- Performance persistence, capture, and fixed-cohort batch: `lib/performance/store.ts`, `lib/performance/postgres.ts`, `lib/performance/capture.ts`, `lib/performance/batch.ts`, `scripts/local-performance.ts`

- Provider contract, atomic snapshot factory, and registry: `lib/providers/base.ts`, `lib/providers/read.ts`, `lib/providers/registry.ts`
- Provider implementations: `lib/providers/*`
- Fusion: `lib/skyFusion.ts`, `lib/liveSkySnapshot.ts`, `lib/liveSkySnapshot.production.ts`
- Comparison: `lib/compare.ts`, `lib/weatherIntelligence.ts`, `lib/weatherIntelligence.production.ts`
- HTTP adapters: `app/api/sky/route.ts`, `app/api/weather/route.ts`
- Radar delivery and rendering: `lib/radar/kma.ts` owns pure KST keys plus sanitized KMA source classification; `lib/radar/delivery.ts` owns window validation, newest-deliverable discovery, bounded admission, same-key single-flight, cancellation, and immutable PNG caching; `lib/radar/apihub.ts` supplies KMA bounds/rendering; `lib/radar/http.ts` maps delivery results; and `app/api/radar/*` are rate-limited HTTP adapters.
- Radar browser loading: `lib/radar/clientLoader.ts` owns sequential fetch/decode state, backpressure retries, cancellation, and blob-URL lifecycle; `lib/radar/presentation.ts` owns pure ordering/playback helpers; `components/atmosphere/sections/RadarSection.tsx` renders only controller-ready frames.
- Shared cache: `lib/cache.ts`

The application does not authenticate users, store profiles, or accept uploads. It persists official station metadata, prospective forecast captures, and KMA observations in PostgreSQL; it does not persist user coordinates.
