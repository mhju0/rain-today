# Weather and environment sources

SeoulSky fixes all requests to Seoul (`37.5665, 126.9780`) and `Asia/Seoul`. All upstream calls run on the server. Provider keys and the MET Norway contact-bearing user agent must never be returned to the browser or written to logs.

The application is usable without keys: Open-Meteo supplies weather and air quality, and RainViewer supplies the conservative rain-approach signal. Optional sources enrich the response and fail independently.

| Source | Purpose | Configuration | Cache | Failure behavior |
| --- | --- | --- | --- | --- |
| Open-Meteo Forecast | Current, hourly, and seven-day baseline | None | 5 min | Expired cache, then route-level 503 |
| Open-Meteo Air Quality | Keyless PM, gases, aerosol, and UV baseline | None | 20 min | Air quality becomes `null` |
| MET Norway | Provider comparison | `MET_NO_USER_AGENT` with contact | 15 min | Provider reports `needs-config` or `error` |
| KMA short-term | Preferred temperature and active precipitation observation | `KMA_SHORT_TERM_API_KEY` | 5 min | Open-Meteo remains authoritative |
| KMA warnings | Official active warnings | `KMA_WARNING_API_KEY` | 5 min | Warnings become `[]` |
| KMA API Hub radar | Displayed HSR reflectivity frames | `KMA_APIHUB_KEY` | 6 h per immutable frame | Basemap and explicit empty state remain |
| AirKorea | Preferred measured air quality | `AIRKOREA_API_KEY` | 20 min | Open-Meteo air quality remains |
| Pirate Weather | Optional provider comparison and precipitation consensus | `PIRATE_WEATHER_API_KEY` | 5 min | Source is omitted |
| WeatherAPI | Optional provider comparison and precipitation consensus | `WEATHERAPI_KEY` | 5 min | Source is omitted |
| RainViewer | Keyless precipitation-approach signal only | None | 10 min | Approach signal becomes `null` |

`lib/cache.ts` provides process-local TTL caching with single-flight refreshes. If a refresh fails and an expired value exists, the provider serves that value with `stale: true`. This is an availability fallback, not durable storage; serverless instances do not share it.

Each forecast provider exposes one Provider Snapshot read. Its availability, cache/freshness metadata, and normalized current, hourly, and daily weather come from the same cached generation. The shared provider instance and its ID-keyed cache are reused by the live Sky snapshot, deferred Weather Intelligence comparison, runtime precipitation collection, and scheduled forecast logging. A missing configuration or failed fetch yields an empty non-OK snapshot; stale last-good data stays an available snapshot with `stale: true`.

## Fusion rules

- `/api/sky` uses Open-Meteo as the complete baseline.
- `chooseCurrent()` prefers KMA temperature and active precipitation when a valid KMA observation is available. It only adopts KMA's condition when KMA reports active precipitation, because the observation feed does not provide complete dry-sky cloud semantics.
- Air quality uses AirKorea, then Open-Meteo, then `null`.
- Warnings come only from KMA. Forecast probability never creates a warning.
- Displayed radar imagery comes from KMA API Hub. RainViewer remains a separate approach signal and never supplies the displayed map.
- Daily precipitation fields use the gated learned multi-provider consensus documented in `lib/reliability/README.md` by default. Set `MULTI_SOURCE_PRECIP=0` only as an emergency opt-out to the single Open-Meteo baseline.
- `/api/weather` compares every configured provider that returns a valid current snapshot. Missing measurements are excluded, never treated as zero.
- Runtime precipitation collection and scheduled forecast logging project daily data only from available snapshots. A non-OK provider or a missing target date is omitted, never represented as a made-up forecast.
- Forecast-provider order remains Open-Meteo, MET Norway, KMA, Pirate Weather, then WeatherAPI. The first available current snapshot in that order is the comparison primary.

## Attribution

The UI must retain the applicable credits: Open-Meteo; MET Norway; 기상청 (KMA); AirKorea; Pirate Weather; WeatherAPI; RainViewer; and © CARTO / © OpenStreetMap for the radar basemap. Check provider terms before changing commercial use, caching, or redistribution behavior.

## Implementation map

- Provider contract, atomic snapshot factory, and registry: `lib/providers/base.ts`, `lib/providers/read.ts`, `lib/providers/registry.ts`
- Provider implementations: `lib/providers/*`
- Fusion: `lib/skyFusion.ts`, `lib/liveSkySnapshot.ts`, `lib/liveSkySnapshot.production.ts`
- Comparison: `lib/compare.ts`, `lib/weatherIntelligence.ts`, `lib/weatherIntelligence.production.ts`
- HTTP adapters: `app/api/sky/route.ts`, `app/api/weather/route.ts`
- Radar rendering: `lib/radar/*`, `app/api/radar/*`
- Shared cache: `lib/cache.ts`

The application does not authenticate users, store profiles, accept uploads, or persist an application database.
