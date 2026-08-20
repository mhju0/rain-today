---
status: accepted
---

# The elevation gate is non-binding and stays as it is

`findStationMatch` refuses a station whose elevation differs from the user's by more than
`maxElevationDifferenceM: 400`, but only when both elevations are known
(`lib/performance/stations.ts:57–67`). Issue #51 asked whether that half of the matcher
is doing anything, and assumed the answer would be either a stricter rule — treat a
missing elevation as a *failed* gate rather than a skipped one — or a wired-up elevation
supply that makes the bound real.

It is neither. [Measurement](../research/station-elevation-gate.md) says the bound never
fires where people are, and the change #51 contemplated is the most expensive one
available.

## Decision

**Change nothing.** `maxElevationDifferenceM` stays at 400, a missing elevation keeps
skipping the gate rather than failing it, and no server-side elevation lookup is added.

Specifically, and in the order #51 raised them:

- **A missing elevation must not fail the gate.** Every Kakao search result and every
  shared link carries `elevationM: null` by construction, so failing closed would strip
  local evidence from every visitor who does not use browser geolocation — to prevent
  zero measured mismatches.
- **400 is not re-derived.** It is inherited rather than chosen, but nothing in the data
  comes near it, so any new number would be equally arbitrary and equally inert.
- **No DEM is wired in.** Supplying a perfect elevation for all 54 sampled centres
  changes **no** station match. It would add a network dependency per forecast for no
  effect.

This record does **not** license changing station eligibility in the other direction
either. Loosening the bound remains ruled out by #29's non-goals.

## Why measurement rejected the stricter rule

Across 54 populated centres — the 36 from ADR 0005's sample plus 18 inland highland 군
added because that is where terrain, not distance, is the risk:

| | |
|---|---|
| centres whose search path supplies an elevation | **0 / 54** |
| \|terrain − nearest station elevation\| | median **25 m**, max **165 m** |
| centres exceeding the 400 m bound | **0 / 54** |
| matches that change when a real elevation is supplied | **0 / 54** |

The structural reason is that only three ASOS stations sit above 400 m — 대관령 772 m,
태백 714 m, 장수 407 m — and all 97 stations carry a known elevation, so the gate's skip
is always caused by the location, never the station.

#51's motivating example does not survive contact with the terrain. It imagines a valley
user matching 대관령 from 10 km away; in fact the **minimum** terrain inside 대관령's
nearest-station catchment is 520 m, because 강릉 (27 m) and 북강릉 (75 m) sit 17–19 km
away and claim the valley. 0% of 대관령's catchment differs from it by more than 400 m.
The stations that do misrepresent their catchments are 태백 (20% of catchment land beyond
the bound) and 장수 (8%) — over terrain, not over people. No sampled centre matched
either.

This is ADR 0005's lesson again in a second dimension: the area-weighted picture and the
where-people-are picture disagree, and only the second one is a product decision.

## Considered options

**Fail the gate when elevation is unknown.** Rejected. Maximum cost — it removes local
evidence from the majority of visits — against zero measured benefit.

**Resolve location elevation server-side from a DEM.** Rejected for now. Executable and
cheap (Open-Meteo's elevation endpoint is keyless and batched), but it moves no match
today, so it buys a per-forecast dependency and nothing else.

**Delete the gate entirely.** Rejected. It is free while inert, and it is the only guard
that would act if the station network changes shape. Deleting it would have to be undone
by the same AWS adoption that is already on the table.

**Keep it and record that it is inert.** Chosen.

## Consequences

The gate stays in the matcher and stays inert. Anyone reading
`maxElevationDifferenceM: 400` should not mistake it for a tuned threshold: it is
inherited, and this record is the reason it survives review unchanged.

Two facts recorded so the next reader does not re-derive them:

- `StationMatch.elevationDifferenceM` is computed and returned but read by no caller. It
  does not reach the view contract and is never displayed. If it is ever surfaced to
  users, the datum mismatch below has to be resolved first.
- Browser `altitude` is height above the WGS84 ellipsoid; KMA elevations are mean sea
  level. The offset is negligible against a 400 m bound but comparable to the median real
  gap of 25 m, so the subtraction is not currently apples-to-apples.

**Revisit when the AWS network is adopted.** 745 stations may add high sites whose
catchments are populated lowland — the one condition under which this bound starts doing
work. That adoption is itself gated on the quality-control question ADR 0005 left open.
