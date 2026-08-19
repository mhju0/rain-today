---
status: accepted
---

# Station proximity changes the wording, not the eligibility

오늘비 weights providers by how well they recently predicted precipitation at the ASOS
station nearest the user. `findStationMatch` accepts a station up to
`maxDistanceKm: 100`, and the local forecast then tells the reader
"최근 **이 지역에서** 누가 더 잘 맞았나" — who was most accurate *in this area* recently.

Issue #29 asked whether that promise is truthful nationwide, and assumed the answer
would be a tighter distance threshold. It is not.

## Decision

**Do not change station eligibility.** `maxDistanceKm` stays at 100 and
`findStationMatch` keeps selecting the nearest eligible station.

**Change what the product says instead.** Station distance selects the wording, not the
evidence. Introduce a `proximity` dimension alongside the existing evidence `status`,
derived from the matched distance against a boundary that lives next to `STATION_POLICY`:

| proximity | distance | wording |
|---|---|---|
| `local` | ≤ 25 km | "최근 이 지역에서" — the current claim, now earned |
| `regional` | 25–100 km | same station, same weights, but named as regional evidence |

`proximity` is orthogonal to `status`. Evidence can be `collecting` at 5 km or `active`
at 30 km, and conflating the two into one enum would make both harder to read. The
existing `status` values (`active`, `collecting`, `unavailable`) and their `reason`
union are unchanged.

## Considered options

- **Tighten `maxDistanceKm` to 50.** Rejected: it would fire for nobody. Every populated
  place measured is already within 50 km, so the rule buys no protection and only ever
  bites someone standing somewhere genuinely remote.
- **Tighten to 25 km.** Rejected: it would strip evidence from roughly 3% of populated
  places — 평택 at 30.2 km, 남양주 at 23.2 km — and hand them equal weights instead, for
  no demonstrated gain in fidelity.
- **Adopt KMA AWS to densify the network first.** Rejected for now; see below.
- **Leave everything alone.** Rejected: the claim "in this area" is not honest at 30 km,
  and the product already knows the distance it is not telling the reader about.
- **Distance selects the wording.** Chosen.

## Why measurement rejected a tighter threshold

Recorded in full in `docs/research/nationwide-verification-coverage.md`.

Measured area-weighted over 25,279 land points on a 0.02° grid inside the service-area
geometry, the current threshold is **non-binding**: 100.0% of land is already within
100 km of an ASOS station, so `maxDistanceKm: 100` rejects nothing and the distance
fallback has never fired for any user.

That framing is the wrong denominator for a product decision. Repeating the measurement
over 36 real administrative centres — the largest cities and 구, plus the island cases
that stress the tail — inverts the conclusion:

| | Area-weighted land | Populated places |
|---|---|---|
| median | 14.9 km | **5.2 km** |
| ≤ 25 km | 90.0% | **97%** |
| ≤ 50 km | 99.9% | **100%** |
| max | 76.1 km | **30.2 km** |

No populated place in Korea is more than about 30 km from an ASOS station. The 76 km
tail is uninhabited shoreline and open water.

The island premise in #29's body does not survive this. 울릉군, 옹진군, 제주시, 서귀포시
and 강화군 all resolve close to a station. What is far from a station is terrain, not
people — and terrain does not read forecasts.

## Why not AWS

[Verified] The `stn_inf` subscription covers the endpoint rather than only `inf=SFC`, so
`inf=AWS` already returns 745 stations on the existing key. Area-weighted, adding them
looks transformative: coverage within 10 km rises from 25% to 89%.

At populated places it moves the median from about 5.2 km to about 3 km. The headline was
an artefact of area weighting.

[Verified] The observation path is unavailable anyway — `kma_sfcdd3` and `awsh` both
return 403, and the pipeline's observations come from data.go.kr `AsosDalyInfoService`,
whose AWS equivalent is a separate unsubscribed service. [Unknown] Whether unmanned AWS
sites publish daily precipitation with ASOS-grade quality control.

Densifying the network is therefore not worth a new subscription and an unverified
quality bar to move a 5 km median to 3 km. Revisit only if `regional` turns out to fire
often enough in practice to bother real users.

## Consequences

The #29 gate is discharged **for station distance only**. Two things it was blocking are
explicitly *not* settled by this record:

- **`normalizeClamped` consolidation.** ADR 0004 defers the merge to "#29 and an ADR that
  picks a projection policy deliberately". This ADR supplies the coverage evidence but
  picks no projection policy, so the merge still needs its own decision record.
- **The elevation gate.** [Verified] `findStationMatch` applies
  `maxElevationDifferenceM: 400` only when both elevations are known, and browser GPS
  altitude is usually absent, so the gate is frequently inert. A valley user can silently
  match a mountain station — 대관령 sits at 772 m — which distorts precipitation far more
  than horizontal distance does. Quantifying it needs a DEM the repository does not have.
  Tracked in #51; this record does not license changing it either.

Two of #29's required outputs are closed as **not needed for this decision** rather than
answered: 읍/면/동 population-weighted coverage, and elevation-difference coverage. The
36-centre sample already showed the decision does not turn on them — every candidate
threshold either fires for nobody or costs users evidence, and a finer population
weighting can only strengthen that, since it would shift the distribution further toward
short distances.

Adding `proximity` changes the `/api/local-forecast` payload, so the route, the consuming
components, and `docs/weather-sources.md` change together. The boundary constant belongs
beside `STATION_POLICY` in `lib/localForecast.ts`, not in JSX, so that the threshold and
the eligibility policy stay readable in one place.

The honest fallback is unchanged: with no eligible station the product still says local
evidence is unavailable and serves equal weights.
