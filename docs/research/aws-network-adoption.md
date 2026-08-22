# AWS network adoption: coverage gain and observation suitability

Evidence for issues #64 and #65, measured 2026-08-22. Supersedes the AWS portions of
[`nationwide-verification-coverage.md`](./nationwide-verification-coverage.md), whose
recommendation 4 is amended by this document.

This document is evidence and a recommendation. It is **not** a decision — no scoring or
station-eligibility change may ship until a decision record supersedes it.

## Conclusion first

**KMA's 방재기상관측(AWS) network cannot serve as ground truth for this project, and the
reason is instrument resolution rather than quality control.**

The AWS precipitation gauge resolves **0.5 mm**. The wet/dry decision this pipeline makes
is at **0.1 mm** — which is KMA's own threshold, not an idiosyncratic choice. **16.3% of
rain days fall below 0.5 mm**, so an AWS gauge would report `0.0` on roughly one rain day
in six.

This needs no subscription to establish, so the 활용신청 in #66 should not be paid.

Notably, the quality-control fears that motivated the question do **not** survive contact
with the sources: AWS sits inside the same KMA QC regime as ASOS, its gauges are heated by
national standard, and KMA doctrine forbids emitting a partial cumulative sum. AWS fails a
question nobody was asking.

## Part 1 — what coverage AWS would buy (#64)

### Method

The area-weighted figures in the earlier document are the wrong denominator for a product
decision. This repeats its "where people actually are" method, widened from 36 places to
**all 229 시군구**.

- Each 시군구 was resolved through the live Kakao adapter (`searchKoreanLocations`), so the
  coordinates are the ones the product would actually resolve. Queries are 시도-prefixed so
  that 중구 and 고성군 cannot resolve to the wrong place. All 229 resolved and all passed
  `isInsideServiceArea`.
- Distances use the Haversine formula and earth radius from `lib/performance/stations.ts`,
  so figures are comparable to what the matcher computes.
- Station catalogs came from apihub `stn_inf`: `inf=SFC` → 97 ASOS, `inf=AWS` → 745.
  [Verified] the AWS set is a superset — every ASOS id appears in it.

⚠️ **The two products do not share a column layout.** `inf=SFC` is
`STN LON LAT STN_SP HT HT_PA HT_TA HT_WD HT_RN STN_AD STN_KO …` (name at index 10);
`inf=AWS` is `STN LON LAT STN_SP HT HT_WD LAU_ID STN_AD STN_KO …` (name at index **8**).
`parseKmaStationCatalog` in `lib/performance/kma.ts` hardcodes index 10, which is correct
for SFC only. Reusing it for AWS yields forecast-zone codes in place of station names.

### Result

| | ASOS only | ASOS + AWS |
|---|---|---|
| median | 8.7 km | **2.1 km** |
| p90 | 20.8 km | 5.0 km |
| max | **30.5 km** | **9.4 km** |
| ≤ 10 km | 55.5% | 100.0% |
| ≤ 25 km | 97.8% | 100.0% |

Split by kind: 시/구/세종 (n=147) median 7.3 km, max 30.2 km; 군 (n=82) median 14.6 km,
max 30.5 km.

**On population weighting.** Place-weighting counts each 시군구 once, so Seoul's 25 구 carry
the same total weight as 25 rural 군. Because 시/구 sit closer to stations than 군 do, true
population weighting pulls the ASOS column toward the 시/구 row — **the ASOS figures above
are therefore conservative.** The earlier document's 36-large-city sample landing at median
5.2 km corroborates the direction. Exact magnitude remains [Unknown]; no population figures
were used, deliberately.

### The ADR 0005 wording boundary

ADR 0005 lets distance choose the wording (local ≤ 25 km / regional), not eligibility or
weights. **5 of 229 places (2.2%) are currently beyond 25 km from ASOS**, and AWS would bring
all five inside it:

| place | ASOS | nearest ASOS | ASOS + AWS | nearest |
|---|---|---|---|---|
| 전남 신안군 | 30.5 km | 목포 | 2.1 km | 지도 (AWS) |
| 경기 평택시 | 30.2 km | 천안 | 0.6 km | 평택 (AWS) |
| 경기 안성시 | 27.4 km | 천안 | 2.7 km | 안성 (AWS) |
| 경북 영양군 | 26.6 km | 청송군 | 5.1 km | 영양 (AWS) |
| 충남 아산시 | 26.0 km | 천안 | 6.0 km | 송악 (AWS) |

An AWS-inclusive Station Match would make the *regional* tier fire for nobody.

### Robustness

[Verified] `inf=AWS` publishes no `HT_RN` (우량계 지상높이) column while `inf=SFC` does, so the
catalog cannot say which AWS sites carry a rain gauge; 745 is an upper bound on precipitation
coverage. Two bounds on the damage:

- **k-th nearest station.** At the 3rd nearest: median 9.2 km, max 22.1 km, still 100% within
  25 km. The coverage conclusion survives two of every three AWS sites having no gauge.
- **KMA's own product counts are smaller than the registry.** The registry returns 738–745,
  but KMA's portal spec table gives **554** for the AWS observation product, and its prose
  says 510여; apihub says 600여. The registry includes 등표/marine and other-agency sites. At
  554/745 (74% retention) the conclusion is comfortably inside the 50% stress test above
  (median 6.6 km, max 19.9 km, 100% within 25 km).

**Any future citation of the 25% → 89.2% area-coverage headline should be re-derived from
554, not 745.**

## Part 2 — whether AWS observations are usable (#65)

### The disqualifier: 0.5 mm resolution against a 0.1 mm threshold

[Verified] 「지상기상관측지침」 §3.1.1 lists the AWS sensor suite as
`기온, 풍향, 풍속, 강수량(0.5mm), 기압, 습도, 강수유무, 시정·현천계`, and §3.2.4 states the AWS gauge
is `종관기상관측장비(ASOS)의 전도형강수량계와 같다`. The standard-spec table [표 23]
(자동기상관측장비의 표준규격, 기상청 고시, 2023-03-06) gives 전도형 resolution 0.5 mm or 1.0 mm,
against 무게식 at 0.1 mm.

[Verified] ASOS reaches 0.1 mm through a **second** sensor. §2.4.6(1):
`0.5mm 강수량센서를 기본으로 사용한다. 단, 0.1mm 강수량센서가 있을 경우에는 누적강수량이 0.5mm 미만일 때
0.1mm 강수량 값을 사용한다.` The AWS chapter lists only the 0.5 mm sensor.

[Verified] 0.1 mm is KMA's own bar, not ours: 강수일수 is defined as
`일강수량이 0.1mm 이상인 날의 수`, and KMA's operational NWP verification scores precipitation at
a 0.1 mm threshold.

### What that costs, measured on this project's own data

Over the ASOS observations this repository already stores (9,132 station-days, 97 stations,
186 dates):

```
wet (>= 0.1 mm)      3,000   (32.9% base rate)
wet but < 0.5 mm       488   → 16.3% of rain days
                             → 5.34% of all station-days
```

The smallest observed values — 0.1 mm on 165 days, 0.2 mm on 131, 0.3 mm on 110, 0.4 mm on
82 — are precisely the band a 0.5 mm bucket reports as `0.0`. An independent scan of the
`AsosDalyInfoService` archive over calendar 2025 across 10 stations found **15.5%**, and
**23.1% in DJF winter**. Two samples, different periods and station sets, same answer.

### Why this matters more than the distance it would fix

Combining with Part 1, in one unit — wrong wet/dry calls as a share of all station-days:

| | median populated place | worst (평택, 30.2 km) |
|---|---|---|
| ASOS today | ~6.5% from distance | ~12% from distance |
| AWS | ~4–5% distance + 5.34% quantization ≈ **9–10%** | ~1% distance + 5.34% ≈ **6.3%** |

**AWS would make ground truth worse at the typical populated place and better only in the
tail.** The two error sources are also not equivalent: distance disagreement is roughly
symmetric, while quantization is **systematically one-directional** — it can only turn a wet
day dry, consistently punishing providers that correctly forecast light rain.

Distance-versus-disagreement was measured on the same stored observations, pairwise across
all 97 ASOS stations:

| separation | disagree on wet/dry | mean abs diff on rainy days |
|---|---|---|
| 5–10 km | 5.9% | 4.2 mm |
| 15–20 km | 9.9% | 7.6 mm |
| 25–30 km | 11.0% | 7.8 mm |
| 30–40 km | 12.0% | 8.9 mm |
| 60–100 km | 17.5% | 11.7 mm |
| 100+ km | 27.2% | 15.5 mm |

Two limits on that table: [Verified] there are **no ASOS pairs closer than 5 km**, so the
sub-5 km regime cannot be measured from ASOS at all; and the sample is May–August, Korea's
convective and 장마 season, when rain is patchiest — these are close to worst-case rates.

### The quality-control questions the ticket asked

All resolve **in AWS's favour**, and none rescues it:

- [Verified] AWS is inside the same QC regime as ASOS. 「기상관측데이터 품질·통계 관리 지침」(2025-09)
  §3.2.1.1 scopes 지상기상관측 as `종관·방재기상관측장비(ASOS·AWS)` together — one flag system,
  one AQC/MQC pipeline, one 기후통계 regime.
- [Verified] Silent partial sums are forbidden: §3.4.3.1.1 and §3.7 require that
  `누적값(합계값)은 누락자료가 있으면 통계값을 산출하지 않는다`.
- [Verified] AWS gauges are heated by national standard ([표 23], ON 4±2 °C / OFF 15±2 °C),
  so the winter-false-dry hypothesis fails on the spec. Winter matters here only because the
  sub-0.5 mm band is widest then.
- [Verified] Neither AWS nor ASOS exposes a precipitation QC flag on the portal. The existing
  ASOS ground truth carries the same limitation.
- [Verified] A daily AWS product exists on all three surfaces, so summing hourly values and
  inheriting the missing-hour trap would not have been necessary.

[Unknown], because the guides are not public: whether AWS precipitation receives the same AQC
algorithm set as ASOS. Moot for this decision.

### Not corroborated — do not cite as settled

- KMA has used AWS precipitation as NWP verification truth since January 2025 on a 244-station
  list. Single source. This is the strongest pro-AWS fact found. Note the reconciliation:
  KMA pools 244 stations over a month at 3/6/12-hour accumulations, where 0.5 mm quantization
  is near zero-mean noise; this project scores one station per user per day, where a single
  spurious `0.0` moves a learned weight. Aggregate and per-station tolerance are different
  bars. [Inferred] — no source compares the two use cases.
- AWS 정상자료율 ≈ 98.8% vs ASOS ≈ 99.0% (Jan–Jul 2026). Retrieved once, not reproduced.
- `RE_SUM` / `RE_QCM` / `강수유무` as an amount-independent wet/dry channel. Field names not
  verified against live output. The only credible mitigation for the 0.5 mm problem, but it
  would redefine what ground truth means.

## Recommendation

1. **Do not adopt AWS, and do not submit the 활용신청.** The blocker is physical and no
   subscription changes it.
2. **Amend, do not reverse, the earlier document's recommendation 4.** Its area-weighting
   critique was right and its numeric estimate was too pessimistic, but the conclusion holds
   for a better reason: not "not worth the cost against unverified QC" but "the instrument
   cannot make the measurement".
3. **Reopen only if** the wet/dry threshold deliberately moves to 0.5 mm at AWS stations, or
   `강수유무` is pursued as a separate channel, or use is restricted to KMA's 244-station
   verification list — noting that list is currently uncorroborated.

## Spin-offs about the existing ASOS pipeline

Found while establishing the above; none is caused by AWS.

- [Verified] `lib/performance/kma.ts:149` and `lib/reliability/groundTruth.ts:82` both read a
  blank `sumRn` as `0` mm. This is deliberate and documented — ASOS leaves the field blank on
  dry days — but it means a genuine outage rendered blank is indistinguishable from a dry day.
  Worth hardening; no mis-scoring incident is evidenced.
- [Verified] `sumRn = 0.0` co-occurs with a non-zero `sumRnDur` on 36–70 days per station per
  year at most stations — days where precipitation demonstrably occurred but the amount rounds
  to zero. `sumRnDur` is an available independent wet/dry signal this project does not use.
- [Unknown] Which daily boundary `AsosDalyInfoService` `dateCd=DAY` `sumRn` uses. KMA guidance
  names 00–24, 09–09 and 21–21 conventions. This affects the **existing** ground truth.
