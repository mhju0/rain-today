# SGIS nationwide boundary acquisition record

**Status:** acquisition checkpoint complete; the authoritative package satisfies the documented island and usage gates

**Retrieved:** 2026-08-15 KST

**Purpose:** record the exact provenance, terms, structure, and verified coverage of the official boundary package selected in [`korea-location-production-readiness.md`](./korea-location-production-readiness.md), so the service-area validator for issue #28 can be generated and regenerated deterministically.

## 1. Source and provenance

| Field | Value |
| --- | --- |
| Dataset | `국가데이터처_SGIS 행정구역 통계 및 경계_20250630` |
| Publisher | 국가데이터처 (공간정보서비스과) |
| Catalogue page | https://www.data.go.kr/data/15129688/fileData.do |
| Machine metadata | https://www.data.go.kr/catalog/15129688/fileData.json |
| File handle | `atchFileId=FILE_000000003681593`, `fileDetailSn=1` |
| Original file name | `국가데이터처_SGIS 행정구역 통계 및 경계.zip` |
| Retrieval date | 2026-08-15 KST |
| Archive size | 269,032,521 bytes (53 entries, 425,976,896 bytes uncompressed) |
| Archive SHA-256 | `f1cf0f9de453ac7eaacb273f39cee52851183372b9ddfda428a967c3a670b2c6` |
| Boundary vintage | 2025년 2분기 기준; every `BASE_DATE` attribute is `20250630` |
| Statistics vintage | 2024년 (not used by SeoulSky) |
| Catalogue `stdrDe` | `06/30/2025` |
| Last modified | 2026-07-23; next scheduled registration 2027-02-01 |
| Update cycle | 반기 (semiannual) |
| Spatial coverage | 대한민국 전체(전국) |

[Verified] The archive downloaded over plain HTTPS with no account, login, token, or API key. The SGIS portal's own bulk-download page (`https://sgis.mods.go.kr/view/pss/downloadList`) does require a member login, so the Public Data Portal copy is the credential-free acquisition path and the one this record describes.

## 2. Terms

[Verified] The catalogue and its machine metadata both state `이용허락범위 제한 없음` — no stated restriction on the scope of permitted use. The package is published under 「통계법」 제4장 제2절 (통계의 보급 및 이용).

This materially differs from the MOLIT/VWorld cross-check source, which carries Korea Open Government License Type 4 (attribution, noncommercial, no modification). Type 4's no-modification condition conflicts with reprojection and union; the SGIS package under `이용허락범위 제한 없음` carries no such stated conflict, so it remains the correct generated-asset source.

[Unknown] "제한 없음" is a catalogue-level declaration, not a named license with published clause text. It is not legal advice and does not by itself resolve attribution wording for a deployed product.

## 3. Package structure

The archive holds four top-level sections. Only `2. 경계` is relevant; the statistics CSVs, code books, and manuals are not used.

```
2. 경계/
  1. 2025년 2분기 기준 시도 경계/    bnd_sido_00_2025_2Q.{shp,shx,dbf,prj,cpg}
  2. 2025년 2분기 기준 시군구 경계/  bnd_sigungu_00_2025_2Q.{shp,shx,dbf,prj,cpg}
  3. 2025년 2분기 기준 읍면동 경계/  bnd_dong_00_2025_2Q.{shp,shx,dbf,prj,cpg}
3. 참고자료/  adm_grid_mapping.xlsx, statistics_code.xlsx, statistics_guide.hwpx, db_schema.hwpx
```

[Verified] Archive member names are CP949-encoded, so extraction must decode them explicitly rather than assume UTF-8.

### Component checksums (SHA-256)

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `bnd_sido_00_2025_2Q.shp` | 86,988,364 | `8edb33f1f633002a41f9bc407943cbebf0c2d8d5b3c18bd3fa5eb41aabe7e77e` |
| `bnd_sigungu_00_2025_2Q.shp` | 97,462,924 | `85523b10411652aa6b5c286a82eff7e77c7e563d5f644eb62a221a121f7e3968` |
| `bnd_dong_00_2025_2Q.shp` | 135,002,820 | `8f5dec93ce06be03402d24c69b7f4643386945ba291cbc9e0b59b4fee992371d` |
| `bnd_*.prj` (all three identical) | 435 | `e21b26451491c617318aab7d28abf4d07f5facc2aed1564e082ec8d4268cfa3b` |

## 4. CRS and encoding

[Verified] All three layers carry an identical `.prj`:

```
PROJCS["Korea_2000_Korea_Unified_Coordinate_System",
  GEOGCS["GCS_Korea_2000",DATUM["D_Korea_2000",SPHEROID["GRS_1980",6378137.0,298.257222101]]],
  PROJECTION["Transverse_Mercator"],
  PARAMETER["False_Easting",1000000.0], PARAMETER["False_Northing",2000000.0],
  PARAMETER["Central_Meridian",127.5], PARAMETER["Scale_Factor",0.9996],
  PARAMETER["Latitude_Of_Origin",38.0], UNIT["Meter",1.0]]
```

This is Korea 2000 / Unified CS (EPSG:5179), confirming the CRS the prior research inferred from the SGIS manual. The `.cpg` files declare `UTF-8`.

[Inferred] Korea 2000 is a GRS80 geocentric datum, so no datum shift to WGS84 is required for a service-area containment decision; the residual difference is far below the 5 km forecast-grid resolution. A locally implemented inverse Transverse Mercator round-trips to within 6 mm across Seoul, Dokdo, Marado, and Baengnyeongdo, so the reprojection needs no external geospatial dependency.

## 5. Measured geometry

All three layers are shape type 5 (Polygon) and share the bounding box `x[746111.0, 1387949.2] y[1458603.2, 2068444.0]` in EPSG:5179.

| Layer | Features | Rings | Vertices | Holes | Rings < 1 ha |
| --- | --- | --- | --- | --- | --- |
| 시도 | 17 | 13,729 | 5,433,279 | 13 | 11,924 |
| 시군구 | 252 | 13,958 | 6,087,118 | 8 | 11,926 |
| 읍면동 | 3,559 | 17,221 | 8,421,798 | 7 | 11,926 |

[Verified] The 시도 layer is the smallest complete representation of national land and is therefore the intended validator source; the finer layers subdivide the same coastline without adding coverage.

[Verified] 11,924 of the 시도 layer's 13,729 rings are smaller than one hectare. Small offshore rocks, not coastline detail, dominate the ring count.

[Verified] The 17 시도 are 서울특별시, 부산·대구·인천·광주·대전·울산광역시, 세종특별자치시, 경기도, 강원특별자치도, 충청북도, 충청남도, 전북특별자치도, 전라남도, 경상북도, 경상남도, 제주특별자치도.

### Independent correctness checks

[Verified] Two measurements taken from the parsed geometry match independently published figures closely enough to validate both the shapefile parser and the projection:

| Feature | Measured from package | Independently known |
| --- | --- | --- |
| 서울특별시 (single outer ring) | 605.30 km² | 605.2 km² |
| 독도 서도 | 89,350 m² | ~88,740 m² |
| 독도 동도 | 73,670 m² | ~73,297 m² |

## 6. Island and service-area coverage

Point-in-polygon was evaluated in the source CRS against the 시도 layer, honouring shapefile ring orientation (clockwise outer, counter-clockwise hole).

**Required islands — all present and containing:**

| Point | Result |
| --- | --- |
| 제주시 | 제주특별자치도 |
| 우도 | 제주특별자치도 |
| 추자도 | 제주특별자치도 |
| 마라도 | 제주특별자치도 |
| 울릉도 | 경상북도 |
| 독도 동도 | 경상북도 |
| 독도 서도 | 경상북도 |
| 백령도 | 인천광역시 |
| 대청도 | 인천광역시 |
| 연평도 | 인천광역시 |
| 흑산도 | 전라남도 |

Mainland controls (서울, 부산, 강릉) also pass.

**Non-service points — all correctly rejected:** 개성 (DPRK), 대마도 (Japan), 후쿠오카 (Japan), 이어도, and open-water points in the Yellow Sea, Korea Strait, and East Sea.

[Verified] 개성 (37.97N, 126.55E) and 대마도 (34.40N, 129.30E) are both admitted by the current `KOREA_BOUNDS` rectangle in [`lib/location.ts`](../../lib/location.ts) and both rejected by this geometry. This is the concrete correctness gain issue #28 requires.

### Enclave holes

[Verified] The 시도 layer carries 13 hole rings. Twelve are intra-province water; one is an enclave — 전라남도 fully encloses 광주광역시, so 전남's polygon has a 498 km² hole (measured; 광주's published area is 501 km²) exactly where the city sits.

[Verified] Holes must therefore be evaluated per feature. Treating them layer-wide rejected every coordinate in 광주, including KMA ASOS station 156 at 35.17294, 126.89156, which the scheduled capture requests on every cycle. An island-only acceptance corpus did not catch this; a per-시도 representative-point corpus does.

### End-to-end verification of the generated asset

[Verified] The shipped asset, decoded by the runtime, was compared against unsimplified geometry on 10,000 points — 6,000 uniform over the national bounding box and 4,000 within 3 km of a boundary vertex. Agreement was 99.87%, and all 13 disagreements lay within 6.8 m of the reference coastline.

[Inferred] That comparison alone is not sufficient evidence of correctness: the first reference implementation shared the layer-wide hole flaw, so both sides agreed on 광주 and the sweep could not surface it. Agreement against a reference is only as strong as the reference's independence.

[Verified] The acceptance set must be tested with genuine interior land coordinates. Plausible-looking centre coordinates for 추자도, 마라도, and 독도 initially fell in water — 독도's commonly cited coordinate lies in the channel between the two islets — and produced false rejections against correct geometry. Island test points in the implementation suite must be justified against the geometry, not assumed from a place-name lookup.

## 7. Consequences for implementation

The acquisition gate in the continuation handoff is satisfied: source URL, vintage, checksum, terms, CRS, sizes, feature count, and required-island coverage are all recorded and verified. Branch A (authoritative service-area validation) is unblocked; the Branch B fallback is not required on boundary-source grounds.

Remaining engineering decisions, to be measured rather than assumed:

- The raw 시도 SHP is 86,988,364 bytes with 5,433,279 vertices. It must stay outside the runtime bundle, and a generated WGS84 asset must be measured for bytes, cold-start cost, and containment latency before any simplification is considered.
- Ring count is dominated by sub-hectare rocks. Any future reduction must be justified by measurement and must leave every required island result unchanged.
- The raw package and every extracted shapefile are intentionally uncommitted.

## 8. Administrative-vintage caveat

[Verified] This 2025-06-30 vintage lists 광주광역시 and 전라남도 as separate 시도. It predates the 2026-07-01 전남광주통합특별시 installation recorded in the continuation handoff.

[Inferred] This does not affect a land-containment validator, because merging two adjacent units does not change the union of national land. It does mean this package must not be used as a source of current administrative names, and the Kakao canonical-name question in issue #25 remains open and independent.

## 9. Update procedure

1. Re-read the catalogue page and confirm a newer `stdrDe` / boundary vintage.
2. Download via the recorded file handle, then record the new archive size and SHA-256.
3. Confirm the `.prj` still declares EPSG:5179 and the `.cpg` still declares UTF-8.
4. Re-run the full island acceptance and rejection corpus before regenerating any asset.
5. Review 시도 names for administrative reorganizations and update this record.
6. Ship the regenerated asset and its new checksum as a normal reviewed change.
