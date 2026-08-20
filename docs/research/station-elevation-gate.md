# The station elevation gate

Evidence for issue #51. Measured 2026-08-20 against the 97-station ASOS catalog in
`lib/performance/stationCatalog.ts` and terrain elevations from Open-Meteo's keyless
elevation endpoint.

This document is evidence and a recommendation. It is **not** a decision — see
[ADR 0006](../adr/0006-the-elevation-gate-is-non-binding.md), which it precedes.

## What the gate is

[Verified] `STATION_POLICY` is `{ maxDistanceKm: 100, maxElevationDifferenceM: 400 }`
(`lib/localForecast.ts:26`). `findStationMatch` computes an elevation difference only
when **both** the location and the station carry one, and applies the bound only when
the difference is non-null (`lib/performance/stations.ts:57–67`):

```ts
const elevationDifferenceM =
  input.location.elevationM == null || station.elevationM == null
    ? null
    : Math.abs(input.location.elevationM - station.elevationM);
```

A missing elevation therefore **skips** the gate rather than failing it.

## Correction to the issue's premise

#51 says "text-search results may carry a provider elevation". They never do.

[Verified] Every Kakao search result is constructed with `elevationM: null`
(`lib/locationSearch.ts:142`) — confirmed against a live response from
`/api/locations/search`, which returns `"elevationM":null` for a resolved 시. Shared
links are the same: `locationFromSearch` hardcodes `elevationM: null`
(`components/local/LocalForecastExperience.tsx:144`).

[Verified] The **only** producer of a non-null location elevation in the codebase is the
browser fix, `position.coords.altitude`
(`components/local/LocalForecastExperience.tsx:390–393`).

So the gate is not "frequently inert" — it is *structurally* inert for every visitor who
types a place name or opens a shared link. It can fire only for someone who taps
내 위치로 보기 **and** whose browser supplies a finite altitude.

Three more structural facts:

- [Verified] **All 97 stations carry an elevation**, so a skipped gate is always the
  location side, never the station side.
- [Verified] **Only three stations exceed 400 m**: 대관령 772 m, 태백 714 m, 장수 407 m.
  For a sea-level user those are the only three the bound could ever exclude.
- [Verified] `StationMatch.elevationDifferenceM` is computed and returned but **read by
  no caller**. It does not reach `LocalForecastView`, is not persisted, and is never
  displayed. The gate's only effect is the exclusion itself.

## Method

**Terrain elevations** came from `GET https://api.open-meteo.com/v1/elevation`, which is
keyless, accepts batched coordinates, and is the same provider already used as the
forecast baseline. Nothing was committed to the repository.

**Instrument check.** Before using it, the DEM was calibrated against all 97 official KMA
station elevations at the stations' own coordinates:

| | |
|---|---|
| median difference | **−2.5 m** |
| mean | −4.5 m |
| worst | −33 m (동두천, official 116 m) |
| within ±50 m | **97 / 97** |

Both series are mean-sea-level referenced and agree closely, so the DEM is sound for
this question.

**Sample.** The 36 administrative centres from
[`nationwide-verification-coverage.md`](nationwide-verification-coverage.md), re-resolved
through the live Kakao adapter so the coordinates are what the product actually returns,
**plus 18 inland highland 군 added for this question**: 평창, 정선, 태백, 영월, 횡성,
인제, 양구, 화천, 홍천, 무주, 진안, 장수, 합천, 산청, 함양, 거창, 봉화, 영양. The coverage
doc had no reason to sample highlands; the elevation gate does. 54 centres in total, all
resolved.

**Catchments.** Nearest-station assignment on a 0.05° grid over 33.1–38.6°N,
125.5–129.6°E, then terrain sampled inside the three above-400 m stations' cells. Points
returning ≤ 5 m were dropped as sea, which would otherwise drag a coastal catchment down.

## Result: the gate never fires where people are

| | 54 populated centres |
|---|---|
| search-path elevation non-null | **0 / 54** |
| \|terrain − nearest station elevation\| | median **25 m**, max **165 m** (울릉군) |
| exceeding the 400 m bound | **0 / 54** |
| matches that change when a real elevation is supplied | **0 / 54** |

The largest gaps are nowhere near the bound:

| Centre | Terrain | Nearest station | Station | Δ |
|---|---|---|---|---|
| 울릉군 | 56 m | 울릉도 | 221 m | 165 m |
| 봉화군 | 210 m | 봉화 | 325 m | 115 m |
| 진안군 | 305 m | 장수 | 407 m | 102 m |
| 용인시 | 127 m | 수원 | 40 m | 87 m |
| 울산 남구 | 8 m | 울산 | 81 m | 73 m |

Supplying a perfect elevation for every one of the 54 changes **no** match. The gate is
non-binding at the current station network.

## Result: 대관령 is not the problem; 태백 is

#51 names 대관령 (772 m) and imagines "a valley user roughly 10 km away". That user does
not exist. Within 대관령's nearest-station catchment the **minimum** terrain is 520 m and
the median is 769 m, against a 772 m station — because 강릉 (27 m, 17.3 km) and 북강릉
(75 m, 18.6 km) sit below it and claim the valley. **0%** of 대관령's catchment differs
from it by more than 400 m. The station represents its catchment well.

| Station | Elevation | Catchment terrain (land) | >400 m from station |
|---|---|---|---|
| 대관령 | 772 m | min 520 · median 769 · max 1132 | **0%** |
| 태백 | 714 m | min 203 · median 831 · max 1292 | **20%** |
| 장수 | 407 m | min 299 · median 562 · max 983 | **8%** |

태백 is the genuinely unrepresentative one and 장수 mildly so — but no populated centre in
the sample matched either, so the misrepresentation is over terrain, not over people.
This is the same lesson #29 learned: weight by where people are, not by land area.

## Two findings the issue did not ask for

**The 400 m bound is inherited, not chosen.** [Verified] It entered in `25201cf` as a
bare literal beside `maxDistanceKm: 100`, and no ADR or research doc justifies the
number. Since the bound is non-binding, its exact value does not currently matter — but
nothing should describe it as a considered threshold.

**The two elevations are not on the same datum.** [Verified] The Geolocation API defines
`altitude` as "the height of the position, specified in meters above the [WGS84]
ellipsoid". KMA station elevations and the DEM are mean-sea-level. [Inferred] In Korea
the geoid–ellipsoid separation is on the order of tens of metres — negligible against a
400 m bound, but comparable to the **median** real gap of 25 m. On the rare occasion the
gate does apply, it is subtracting two numbers measured from different surfaces.

## Recommendation

1. **Do not fail closed on a missing elevation.** It would exclude every text-search and
   shared-link visitor from local evidence to buy protection that measures at exactly
   zero across all 54 centres. This is the single most costly available change and the
   least justified.
2. **Do not change 400**, and do not tighten it. Nothing is near it.
3. **Do not wire a server-side DEM to "make the gate work".** It is executable — the
   endpoint is keyless — but 0 of 54 matches would move, so it adds a network dependency
   on every forecast for no measured effect.
4. **Leave the gate in place.** It costs nothing, and it is the only guard that would act
   if the station network ever changes shape.
5. **Revisit if the AWS network is adopted.** 745 stations
   ([`nationwide-verification-coverage.md`](nationwide-verification-coverage.md)) may
   include high sites whose catchments are populated lowland, which is the one condition
   under which this bound starts doing work.

## Reproducing

The measurement scripts were run from a scratch directory and not committed. Four things
cost time and are worth knowing:

- `/api/locations/search` rate-limits at **20 requests / 60 s**
  (`app/api/locations/search/route.ts:9`). Resolving 54 names in parallel returns
  `too many requests` for most of them and looks like a search failure. Walk the list.
- Open-Meteo's elevation endpoint takes **~90 coordinates per call** as comma-separated
  `latitude=` and `longitude=` lists.
- The DEM returns ~0 over water; filter before taking catchment statistics.
- `npx tsx` needs the file named `.mts` for top-level await.
