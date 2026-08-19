# Nationwide forecast verification coverage

Evidence for issue #29. Measured 2026-08-19 against the 97-station ASOS catalog
committed in `39f7e0a` and the 2025-06-30 SGIS service-area geometry in
`lib/locationServiceAreaData.ts`.

This document is evidence and a recommendation. It is **not** a decision — no scoring
or station-eligibility change may ship until a decision record supersedes it.

## Method

Land points were sampled on a 0.02° grid (~1.8 km meridional) across the bounding box
33.0–38.7°N, 125.0–130.0°E and kept when `isInsideServiceArea` accepted them, giving
**25,279 land points**. For each point, great-circle distance to the nearest station
was computed with the same Haversine formula and earth radius that
`lib/performance/stations.ts` uses, so the numbers are comparable to what the matcher
actually does.

**This is area-weighted, not population-weighted.** #29 asks for 읍/면/동
representative points; the repository has only 시도 boundary polygons, and the SGIS
읍면동 package must not be committed. Area weighting over-represents mountains,
forest, and uninhabited islands relative to where people live, so **true user-facing
coverage is better than every figure below.** The population-weighted number remains
open.

## Result: ASOS alone

| Threshold | Share of land |
|---|---|
| ≤ 10 km | 25.0% |
| ≤ 25 km | 90.0% |
| ≤ 50 km | 99.9% |
| ≤ 100 km | 100.0% |

Median 14.9 km · p90 25.0 km · p99 33.7 km · max 76.1 km.

**The current 100 km threshold is non-binding.** [Verified] Every sampled land point
in the service area is within 100 km of an ASOS station, so `maxDistanceKm: 100`
rejects nothing and provides no protection. Whatever the fallback language promises,
today it never fires for distance.

Only **23 of 25,279** points exceed 50 km, and every one is an island or a remote
coastal fringe:

| Distance | Nearest station | Point |
|---|---|---|
| 76.1 km | 흑산도 | 34.06, 125.12 |
| 66.6 km | 고흥 | 34.02, 127.30 |
| 65.9 km | 강화 | 37.66, 125.70 |
| 56.9 km | 서산 | 37.18, 126.10 |
| 56.7 km | 보령 | 36.12, 125.98 |
| 53.9 km | 제주 | 33.96, 126.30 |

This matches the concern in #29: the users a 100 km rule fails to protect are island
and coastal users, and they are exactly the ones whose weather a distant mainland
station represents worst.

## Result: the AWS option

[Verified] The `stn_inf` subscription obtained on 2026-08-19 covers the endpoint, not
just `inf=SFC`. `inf=AWS` returns **HTTP 200 and 745 stations**, every one inside the
service-area bounds, and the set is a superset — all 97 ASOS ids appear in it.

| Network | Stations | ≤10 km | ≤25 km | ≤50 km | Median | Max |
|---|---|---|---|---|---|---|
| ASOS | 97 | 25.0% | 90.0% | 99.9% | 14.9 km | 76.1 km |
| ASOS + AWS | 745 | **89.2%** | **100.0%** | 100.0% | **5.8 km** | **26.9 km** |

Adding AWS would put every land point in Korea within 25 km of an observation and
close to 90% within 10 km. It would make a 25 km eligibility rule viable nationwide,
which ASOS alone cannot support.

### The blocker

[Verified] The observation data path is not available. `kma_sfcdd3` (지상 일자료) and
`awsh` (AWS 시간자료) both return **HTTP 403** under the current key, for an
AWS station id and for ASOS 서울 alike. Those are separate 활용신청 items under the
종관기상관측(ASOS) and 방재기상관측(AWS) tabs.

The pipeline's existing observations do not come from apihub at all — they come from
data.go.kr `AsosDalyInfoService` with `dataCd=ASOS`, which is subscribed and working.
The AWS equivalent is data.go.kr 15139433, referenced in #29 and **not** subscribed.

[Unknown] Whether AWS daily precipitation sums are published with the same
quality control as ASOS `sumRn`. AWS sites are unmanned, and #29 asks specifically
whether the required historical and quality-controlled fields are available
operationally. That cannot be answered until the subscription exists and real rows can
be inspected. **Coverage is not the same as trustworthy coverage**, and AWS should not
be adopted on the strength of the distance numbers alone.

## Recommendation

1. **Do not loosen anything.** The measurements give no argument for a threshold above
   100 km, and #29's non-goals rule it out anyway.
2. **Tightening to 50 km costs 0.1% of land area** and would make the threshold
   meaningful for the first time, since it would actually fire — for island and remote
   coastal users, who would fall back to equal weights with honest language rather than
   being weighted by a station up to 76 km away.
3. **Do not tighten to 25 km on ASOS alone.** It would strand 10% of land area, and the
   user-facing state would be "local evidence unavailable" across large rural regions.
4. **Treat AWS as the unlock for a 25 km rule**, gated on subscribing to the AWS
   observation service and verifying field quality — not on these distance figures.
5. **Elevation stays unresolved.** [Verified] `findStationMatch` only applies the
   elevation gate when both elevations are known, and browser GPS altitude is usually
   absent, so the gate is frequently inert. Quantifying that needs a DEM the repository
   does not have.

## Still open in #29

- 읍/면/동 population-weighted coverage (needs the SGIS 읍면동 package)
- Elevation-difference coverage and missing-elevation rates (needs a DEM)
- AWS field quality and historical availability (needs the subscription)
- User-facing language for the active / regional / collecting / unavailable states
- The decision record itself
