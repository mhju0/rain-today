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

## Result: where people actually are

The area-weighted figures above are the wrong denominator for a product decision, so the
same measurement was repeated over 36 real administrative centres — the largest cities
and 구, plus the island cases that stress the tail (울릉군, 옹진군, 제주시, 서귀포시,
강화군, 목포시, 통영시, 여수시). Coordinates came from the live Kakao adapter, so these
are the points the product would actually resolve.

| | Area-weighted land | Populated places |
|---|---|---|
| median | 14.9 km | **5.2 km** |
| ≤ 10 km | 25.0% | 67% |
| ≤ 25 km | 90.0% | **97%** |
| ≤ 50 km | 99.9% | **100%** |
| max | 76.1 km | **30.2 km** |

The furthest are 평택 30.2 km (→ 천안), 남양주 23.2 km and 성남 22.0 km (both → 서울),
용인 17.3 km (→ 수원). **No populated place in Korea is more than about 30 km from an
ASOS station**, and the 76 km tail is uninhabited shoreline and open water.

The island worry in #29 does not survive contact with this data: 울릉군, 옹진군, 제주시,
서귀포시 and 강화군 all resolve close to a station. What is far from a station is terrain,
not people.

## Recommendation

1. **Do not loosen anything.** #29's non-goals rule it out and nothing here argues for it.
2. **Do not tighten the distance threshold either.** A 50 km rule would fire for nobody —
   100% of populated places are already inside it — so it would buy zero protection while
   adding a failure mode for anyone standing somewhere genuinely remote. A 25 km rule
   would fire for roughly 3% of populated places, including 평택 and 남양주, which is a
   real cost for no demonstrated benefit. **The distance threshold is not the problem.**
3. **Fix the language instead.** The honest defect is that evidence from 30 km away is
   presented the same way as evidence from 5 km. #29 already asks for the four-state
   vocabulary; introduce the *regional* tier and let distance choose the wording rather
   than the eligibility:
   - **local** (≤ 25 km) — 97% of populated places; "recent performance near you"
   - **regional** (25–100 km) — same weights, same station, but says so
   - **collecting** — station matched, evidence below `minimumSamples`
   - **unavailable** — no eligible station; equal weights
   This costs no user their evidence, and makes the claim true at every distance.
4. **Deprioritise AWS.** The 25% → 89% headline is area-weighted and overstates the user
   impact badly: at populated places it would move the median from about 5.2 km to
   roughly 3 km. That is not worth a new subscription against unverified quality control
   on unmanned sites. Revisit only if the *regional* tier turns out to fire often enough
   to annoy real users.

   > **Amended 2026-08-22 by [`aws-network-adoption.md`](./aws-network-adoption.md).**
   > The conclusion stands but both halves of the reasoning were wrong. Measured rather
   > than estimated, the population-basis gain is *larger* than "roughly 3 km" — median
   > 8.7 → 2.1 km over all 229 시군구, max 30.5 → 9.4 km. And the quality-control worry
   > below is misplaced: AWS sits inside the same KMA QC regime as ASOS, its gauges are
   > heated by national standard, and partial cumulative sums are forbidden by doctrine.
   > AWS is nonetheless ruled out, on a ground not considered here: its gauge resolves
   > **0.5 mm** against this project's (and KMA's) **0.1 mm** wet/dry threshold, and 16.3%
   > of rain days fall below 0.5 mm. Also note the 745-station figure used above is a
   > registry count; KMA's AWS data product lists 554.
5. **Elevation is the real unquantified risk, not distance.** [Verified]
   `findStationMatch` applies the elevation gate only when both elevations are known, and
   browser GPS altitude is usually absent, so the gate is frequently inert. A valley user
   can silently match a mountain station — 대관령 sits at 772 m — which distorts
   precipitation far more than a few extra kilometres of horizontal distance. Quantifying
   it needs a DEM the repository does not have.

## Still open in #29

- ~~읍/면/동 population-weighted coverage~~ — addressed on a 시군구 basis in
  [`aws-network-adoption.md`](./aws-network-adoption.md); a true 읍면동 basis still needs the
  SGIS package
- Elevation-difference coverage and missing-elevation rates (needs a DEM)
- ~~AWS field quality and historical availability~~ — **closed** in
  [`aws-network-adoption.md`](./aws-network-adoption.md); answered without the subscription
- User-facing language for the active / regional / collecting / unavailable states
- The decision record itself
