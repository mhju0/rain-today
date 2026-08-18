# Korea-wide location production readiness

**Status:** implementation recommendation complete; credentialed Kakao validation and boundary-asset inspection remain release gates

**Researched:** 2026-08-15

**Scope:** production readiness for 오늘비's Korea-wide location search and current-location flow. External claims use first-party Kakao, Korean government, KMA, or SGIS sources. This is an engineering recommendation, not legal advice.

## Executive decision

Keep Kakao Local address search as the manual-search provider, but do not call the search flow production-validated until it passes the credentialed matrix below. Kakao documents the exact server authentication method and the administrative/legal fields 오늘비 needs, but it does not publish a Local-specific per-second limit, a REST-result attribution rule, a cache TTL, or a guarantee that a bare administrative-area result is a geographic centroid. Those four points remain explicit unknowns. [Kakao Local REST guide](https://developers.kakao.com/docs/ko/local/dev-guide) · [Kakao REST response-code reference](https://developers.kakao.com/docs/ko/rest-api/reference) · [Kakao Developers operating policy](https://developers.kakao.com/terms/en/site-policies-20250304)

[Verified] Replace the current rectangular South Korea check with a server-side point-in-polygon validator derived from the latest official SGIS nationwide administrative-boundary file. [`lib/location.ts`](../../lib/location.ts) SGIS publishes census administrative boundaries for the whole country at all, province, city/county/district, and 읍면동 levels as free SHP data; the public-data catalogue currently packages 2025 boundaries and describes a semiannual publication cycle. [SGIS data catalogue](https://sgis.mods.go.kr/view/pss/openDataIntrcn) · [Public Data Portal SGIS boundary package](https://www.data.go.kr/data/15129688/fileData.do)

Do not use KMA latitude/longitude-to-grid conversion as a service-area validator. The official converter accepts a broad numeric domain and maps an arbitrary coordinate to the nearest forecast grid; the KMA grid specification includes sea and non-observation cells, so obtaining an `nx,ny` pair proves projection into the grid, not that the input is South Korean land or that forecast data exists there. [KMA API Hub coordinate converter](https://apihub.kma.go.kr/apiList.do?apiMov=4.+%EB%8F%99%EB%84%A4%EC%98%88%EB%B3%B4%28%EC%B4%88%EB%8B%A8%EA%B8%B0%EC%8B%A4%ED%99%A9%C2%B7%EC%B4%88%EB%8B%A8%EA%B8%B0%EC%98%88%EB%B3%B4%C2%B7%EB%8B%A8%EA%B8%B0%EC%98%88%EB%B3%B4%29+%EC%A1%B0%ED%9A%8C&seqApi=10&seqApiSub=286) · [KMA forecast-grid specification](https://apihub.kma.go.kr/getAttachFile.do?fileName=%2820240305%29%EB%8F%99%EB%84%A4%EC%98%88%EB%B3%B4+%EA%B2%A9%EC%9E%90%EC%98%81%EC%97%AD+%EC%A0%95%EB%B3%B4.pdf)

## 1. Kakao Local production findings

### Authentication and application setup

- Address search is `GET https://dapi.kakao.com/v2/local/search/address.json`; the required request header is `Authorization: KakaoAK ${REST_API_KEY}`. JSON is the default response format, and the endpoint also supports XML. [Kakao Local REST guide](https://developers.kakao.com/docs/ko/local/dev-guide)
- A Kakao Developers application must exist, Kakao Map must be enabled for that application, and the REST API key must have the required settings registered. Kakao says this setup changed on 2026-07-21. [Kakao Map usage setup](https://developers.kakao.com/docs/ko/kakaomap/common)
- Kakao grants the Map free quota only to the first Map-enabled application on a developer account. A later Map-enabled application, or an application that needs usage beyond its free quota, requires a Biz Wallet and paid-API activation. [Kakao Map usage policy](https://developers.kakao.com/docs/ko/kakaomap/common)
- The REST API key is an application credential, so the browser must call 오늘비's server route rather than Kakao directly. Kakao's security guide also recommends restricting callable IP addresses or configuring a client secret when the API supports those controls. [Kakao REST API reference](https://developers.kakao.com/docs/ko/rest-api/reference) · [Kakao security guidelines](https://developers.kakao.com/docs/en/getting-started/security-guideline)

**Recommendation:** keep `KAKAO_REST_API_KEY` server-only, enable Kakao Map on the intended production app, verify that app's “Kakao Map free quota” badge, and set budget alerts before making the feature public. Do not put the key or a credentialed response fixture in the repository.

### Quotas, billing, and overload behavior

Kakao currently lists 100,000 free calls per day for address-to-coordinate conversion and another 100,000 per day for coordinate-to-region conversion. It also lists a 3,000,000-call monthly free quota across APIs, notes that quota amounts can change, and says additional paid-quota calls are not deducted from that monthly free pool. [Kakao quota guide](https://developers.kakao.com/docs/en/getting-started/quota)

The current additional-quota prices are KRW 0.5 per address conversion and KRW 0.5 per coordinate-to-region conversion. Kakao says fees and limits can change, so the deployed application's live quota page and connected Biz Wallet are the operational source of truth. [Kakao quota and price guide](https://developers.kakao.com/docs/en/getting-started/quota) · [Kakao Developers Terms, API fees](https://developers.kakao.com/terms/en/site-terms-20250304)

Kakao documents HTTP `429 Too Many Request` for Local when a quota or per-second request limit is exceeded, but the public quota table does not state a Local-specific per-second number. The common error catalogue separately documents error code `-10` for exceeding the permitted request count. [Kakao REST API reference](https://developers.kakao.com/docs/ko/rest-api/reference) · [Kakao error codes](https://developers.kakao.com/docs/ko/rest-api/error-code)

**Recommendation:** retain 오늘비's own per-client throttling and debounce, treat `429` as temporary provider unavailability, and monitor Kakao's application quota dashboard. Do not assume a particular retry window because the reviewed official documentation does not publish one.

### Administrative versus legal-area response contract

For address search, `address_type` distinguishes `REGION`, `ROAD`, `REGION_ADDR`, and `ROAD_ADDR`. An address record supplies province-level `region_1depth_name`, district-level `region_2depth_name`, legal-dong `region_3depth_name`, administrative-dong `region_3depth_h_name`, administrative code `h_code`, legal code `b_code`, and longitude/latitude as `x,y`. Kakao's own example returns legal dong `부송동` and administrative dong `삼성동` in the same record, proving that the two names can legitimately differ. [Kakao Local address-search response](https://developers.kakao.com/docs/ko/local/dev-guide)

The coordinate-to-region endpoint is the unambiguous canonicalization contract: each returned record has `region_type` `H` for administrative dong or `B` for legal dong, a full `address_name`, hierarchy fields, a region `code`, and coordinates. Kakao describes the endpoint as suitable for connecting a coordinate to services including weather. [Kakao Local coordinate-to-region response](https://developers.kakao.com/docs/ko/local/dev-guide)

The address-search documentation says the returned coordinates locate the requested address, but it does not define the coordinate of a bare `REGION` result as a centroid, interior point, government-office point, or any other representative-point policy. [Kakao Local REST guide](https://developers.kakao.com/docs/ko/local/dev-guide)

**Recommendation:** continue labeling search coordinates as an “area representative point,” never a neighborhood centroid. When a returned document has different legal and administrative names, expose two distinguishable selectable candidates. For the credentialed release matrix, call coordinate-to-region only as a validation probe and compare its `H` and `B` codes with the address-search fields; do not add a second Kakao call to every production keystroke.

### Display, attribution, and caching

Kakao publishes Map logo assets specifically for services using Map/Local APIs and says the accompanying design guide should be followed. The reviewed Local REST and Map usage pages do not state that a text-only address-result list must display that logo, so a mandatory attribution treatment for this exact UI is not established by the public documentation. [Kakao Map resource page](https://developers.kakao.com/tool/resource/map) · [Kakao Map usage FAQ](https://developers.kakao.com/docs/ko/kakaomap/common)

Kakao's operating policy prohibits removing included copyright, trademark, or ownership notices and prohibits suggesting an unapproved partnership. It also prohibits caching Kakao-provided data for purposes other than improving the in-app user experience or keeping stale cached data instead of the most recently updated data. [Kakao Developers operating policy, Article 5](https://developers.kakao.com/terms/en/site-policies-20250304)

The same policy restricts copying, publishing, indexing, or providing information obtained through the service to others without prior approval. The general terms require compliance with privacy law when a member supplies Kakao with service-user data. [Kakao Developers operating policy, Article 5](https://developers.kakao.com/terms/en/site-policies-20250304) · [Kakao Developers Terms, Article 11](https://developers.kakao.com/terms/en/site-terms-20250304)

No reviewed official page states a cache TTL or retention period for Local address results. [Kakao Local REST guide](https://developers.kakao.com/docs/ko/local/dev-guide) · [Kakao Developers operating policy](https://developers.kakao.com/terms/en/site-policies-20250304)

**Recommendation:** do not persist raw queries, complete Kakao result sets, or exact selected coordinates. Keep only transient request coalescing if needed, avoid a shared long-lived search-result cache, identify Kakao as the search provider in 오늘비's data-source/privacy copy, and ask Kakao support to confirm the required attribution and any allowed cache duration before marking the integration legally cleared.

### Credentialed release matrix

Run this matrix against the production Kakao application, save redacted expected-result snapshots, and record the execution date. Do not record the API key, unredacted residential input, or a user's device coordinate.

| Group | Queries or action | Required evidence |
| --- | --- | --- |
| Major hierarchy | `서울`, `서울시`, `부산`, `세종시`, `제주시`, `서귀포시` | Full hierarchy, valid finite WGS84 coordinate, stable result ordering across three runs |
| District shapes | `강남구`, `서울 강남구`, `영통구`, `수원시 영통구`, `창원시 마산합포구` | Qualified query ranks the matching hierarchy first; bare duplicate never becomes an unlabeled single claim |
| Legal/admin split | `삼성동`, `서울 강남구 삼성동`, `신대방제2동`, `잠실본동` | Distinct `h_code`/`b_code` and labels are preserved where names differ; coordinate-to-region returns matching `H`/`B` records |
| 읍/면/리 | `애월읍`, `제주 애월읍`, `우도면`, `백령면`, `울릉읍`, `독도리` | Rural and island units either resolve with a full hierarchy or fail honestly; no fabricated suffix fallback |
| Duplicate leaf | `남면`, `중앙동`, `삼성동` | Multiple jurisdictions remain separate and selectable; IDs do not collide |
| Address out of product scope | `서울 강남구 테헤란로 152` and one jibun address owned by the tester | Kakao may return an address, but 오늘비 rejects it from the administrative-area picker rather than relabeling it as a neighborhood |
| Input normalization | composed/decomposed Hangul, full-width characters, repeated spaces, leading/trailing spaces | Equivalent normalized input produces equivalent displayed candidates without mutating meaningful suffixes |
| Invalid input | one Hangul character, punctuation only, Latin-only text, more than the product maximum | 오늘비 rejects locally or returns an honest empty state without calling Kakao unnecessarily |
| Authentication | missing key, invalid key, Map disabled for the app | Stable unavailable state; no credential detail reaches the browser or logs |
| Provider pressure | controlled test double for `429`, `500`, timeout, and malformed/oversized JSON | Retry/unavailable UI is bounded; prior results are not shown as a new query's results |
| Boundary handoff | every accepted result above | Representative coordinate passes the official service-area polygon before KMA-grid conversion |

The matrix's field expectations come from Kakao's documented address and coordinate-to-region response contracts; the choice of test queries and product acceptance behavior is 오늘비's release policy. [Kakao Local REST guide](https://developers.kakao.com/docs/ko/local/dev-guide)

## 2. Official boundary and KMA-grid findings

### Preferred source: SGIS nationwide administrative boundaries

SGIS publishes census administrative boundaries for `전체`, `시도`, `시군구`, and `읍면동`, covering the whole country. The official catalogue lists annual boundary vintages from 2001 through 2025, older five-year vintages from 1975 through 2000, SHP format, public availability, and no charge. [SGIS data catalogue](https://sgis.mods.go.kr/view/pss/openDataIntrcn)

The Public Data Portal's current package says it includes 2025 boundary data plus 2024 administrative statistics, contains CSV and SHP materials, has nationwide spatial coverage, is free with no stated license-scope restriction, and is updated semiannually. It says a boundary download includes the SHP companion files such as CPG, DBF, PRJ, and SHX. [Public Data Portal SGIS boundary package](https://www.data.go.kr/data/15129688/fileData.do)

The official SGIS small-area manual says SGIS boundary files use EPSG:5179 and that a shapefile is made of roughly five companion files including `.shp`, `.dbf`, and `.prj`. [SGIS small-area statistics manual](https://sgis.mods.go.kr/html/attachFiles/SGIS%20%EC%86%8C%EC%A7%80%EC%97%AD%20%ED%86%B5%EA%B3%84%20%EC%9D%B4%EC%9A%A9%EB%A7%A4%EB%89%B4%EC%96%BC.pdf)

The official SGIS OpenAPI can return administrative boundaries as GeoJSON by year and administrative code, but it requires an access token. SGIS says the token is obtained with a service ID and secret and is valid for four hours. [SGIS boundary API definition](https://sgis.mods.go.kr/developer/html/newOpenApi/api/dataApi/addressBoundary.html) · [SGIS authentication guide](https://sgis.mods.go.kr/developer/html/newOpenApi/api/dataApi/authAndUseApi.html)

The current SGIS introduction says the OpenAPI is free and has unlimited daily use, while the still-published API terms say one key is limited to 50,000 requests per day. This official-source conflict makes a runtime SGIS boundary dependency unsafe until SGIS confirms which rule governs the production key. [SGIS OpenAPI introduction](https://sgis.mods.go.kr/developer/html/newOpenApi/api/intro.html) · [SGIS OpenAPI terms](https://sgis.mods.go.kr/developer/html/newOpenApi/app/rules.html)

**Suitability:** the downloadable SGIS file is the best reviewed source for 오늘비's local validator because it is nationwide, versioned, free, and avoids per-request credentials, vendor latency, and the conflicting API-limit statements. Use the 읍면동 geometry only to construct the land-service union; do not bundle the statistics tables.

### Cross-check source: MOLIT/VWorld census administrative-dong boundary

The Ministry of Land, Infrastructure and Transport also lists a nationwide SHP census administrative-dong boundary with 3,518 rows and an annual update cycle through VWorld. Its machine-readable public-data metadata assigns Korea Open Government License Type 4: attribution, noncommercial use, and no modification. [MOLIT boundary catalogue](https://www.data.go.kr/data/15125055/fileData.do) · [MOLIT boundary machine metadata](https://www.data.go.kr/catalog/15125055/fileData.json)

**Suitability:** use this source only to cross-check feature counts, names, and island presence. Its stated no-modification and noncommercial conditions conflict with the proposed reprojection, union, simplification, and unrestricted deployment path, so it is not the recommended generated-asset source without separate permission.

### Island and Jeju coverage

The SGIS catalogue describes the boundary product as nationwide, but the reviewed catalogue and manual do not enumerate which small offshore islands are represented or the minimum polygon area retained. Therefore Jeju and major inhabited islands are expected by the nationwide designation, but actual geometry coverage remains unverified until the SHP is downloaded and inspected. [SGIS data catalogue](https://sgis.mods.go.kr/view/pss/openDataIntrcn) · [Public Data Portal SGIS boundary package](https://www.data.go.kr/data/15129688/fileData.do)

KMA's national forecast grid is 149 by 253 cells at 5 km spacing, and its published diagram explicitly labels Dokdo and Ieodo. The 제주지방기상청 separately states that Jeju uses 43 neighborhood-forecast zones at 5 km spacing. These facts establish forecast-domain coverage for Jeju and far-eastern/southern island areas, but they do not prove that a specific SGIS land polygon contains each island or that every grid cell contains forecast data. [KMA forecast-grid specification](https://apihub.kma.go.kr/getAttachFile.do?fileName=%2820240305%29%EB%8F%99%EB%84%A4%EC%98%88%EB%B3%B4+%EA%B2%A9%EC%9E%90%EC%98%81%EC%97%AD+%EC%A0%95%EB%B3%B4.pdf) · [Jeju Regional Meteorological Administration forecast areas](https://www.weather.go.kr/jeju/html/info/business02.jsp)

**Acceptance set:** inspect the source and generated asset for Jeju, Udo, Chuja, Mara, Ulleungdo, Dokdo, Baengnyeongdo, Daecheongdo, Yeonpyeongdo, and Heuksando. Also test ocean points immediately outside each coast plus points in North Korea, China, and Japan. If an official source omits an intended serviced island, stop and select an additional authoritative geometry source; do not hand-draw an exception polygon.

### KMA arbitrary-coordinate conversion

KMA's API Hub provides both grid-to-coordinate and arbitrary-coordinate-to-nearest-grid conversion. For the latter it documents longitude `123.310165` through `132.774963`, latitude `31.651814` through `43.393490`, grid x `1` through `149`, grid y `1` through `253`, and an issued KMA API key. [KMA API Hub coordinate converter](https://apihub.kma.go.kr/apiList.do?apiMov=4.+%EB%8F%99%EB%84%A4%EC%98%88%EB%B3%B4%28%EC%B4%88%EB%8B%A8%EA%B8%B0%EC%8B%A4%ED%99%A9%C2%B7%EC%B4%88%EB%8B%A8%EA%B8%B0%EC%98%88%EB%B3%B4%C2%B7%EB%8B%A8%EA%B8%B0%EC%98%88%EB%B3%B4%29+%EC%A1%B0%ED%9A%8C&seqApi=10&seqApiSub=286)

KMA describes short-range forecasts as a nationwide 5 km by 5 km grid centered on 읍면동 administrative areas. Its detailed grid specification uses Lambert conformal conic projection, a 5 km interval, and `-99.0` for non-observation areas. [KMA short-range forecast service](https://www.data.go.kr/data/15139470/openapi.do) · [KMA forecast-grid specification](https://apihub.kma.go.kr/getAttachFile.do?fileName=%2820240305%29%EB%8F%99%EB%84%A4%EC%98%88%EB%B3%B4+%EA%B2%A9%EC%9E%90%EC%98%81%EC%97%AD+%EC%A0%95%EB%B3%B4.pdf)

**Recommendation:** keep projection local, but verify the implementation against KMA's converter for a fixed mainland/Jeju/island corpus whenever projection code changes. Run land containment first; then convert the accepted coordinate to KMA `nx,ny`; then let the weather-provider layer report an honest unavailable result if that cell has no data.

### Operational size and cost

- The preferred SGIS file is free, bulk-downloadable SHP, so it has no documented per-request production fee. [SGIS data catalogue](https://sgis.mods.go.kr/view/pss/openDataIntrcn) · [Public Data Portal SGIS boundary package](https://www.data.go.kr/data/15129688/fileData.do)
- Neither reviewed SGIS catalogue publishes the compressed download size, uncompressed size, vertex count, or generated WGS84 asset size. [SGIS data catalogue](https://sgis.mods.go.kr/view/pss/openDataIntrcn) · [Public Data Portal SGIS boundary package](https://www.data.go.kr/data/15129688/fileData.do)
- The SGIS boundary API is also described as free, but its current usage-limit documentation conflicts and it requires a renewable access token. [SGIS OpenAPI introduction](https://sgis.mods.go.kr/developer/html/newOpenApi/api/intro.html) · [SGIS OpenAPI terms](https://sgis.mods.go.kr/developer/html/newOpenApi/app/rules.html) · [SGIS authentication guide](https://sgis.mods.go.kr/developer/html/newOpenApi/api/dataApi/authAndUseApi.html)

**Recommendation:** measure the downloaded SHP, WGS84 output, server bundle, cold-start time, and containment latency before choosing an encoding. Keep raw SHP outside the runtime bundle. Generate a server-only, checksummed spatial asset with bounding boxes and preserved polygon holes; start without simplification, then simplify only if tests prove that every required island and coastline case is unchanged. Do not send nationwide geometry to the browser.

## 3. Recommended implementation path

1. **Close Kakao account gates.** Enable Kakao Map on the intended production application, verify its quota status and billing posture, and obtain written clarification on text-result attribution and any permitted search-result cache duration. [Kakao Map usage setup](https://developers.kakao.com/docs/ko/kakaomap/common) · [Kakao Map/Local support route](https://developers.kakao.com/docs/ko/kakaomap/common)
2. **Run the credentialed matrix unchanged.** Store only redacted response shapes and expected codes. A failure in duplicate names, administrative/legal separation, rural/island lookup, authentication, or provider-error behavior blocks release. [Kakao Local REST guide](https://developers.kakao.com/docs/ko/local/dev-guide)
3. **Acquire the latest SGIS nationwide 읍면동 boundary package.** Record source URL, boundary year, retrieval date, checksum, included license/readme, CRS, raw sizes, and feature count. The current official package is based on 2025 boundaries and is catalogued for semiannual updates. [Public Data Portal SGIS boundary package](https://www.data.go.kr/data/15129688/fileData.do)
4. **Build one deterministic server asset.** Reproject EPSG:5179 to WGS84, retain all polygon and multipolygon parts and holes, attach per-feature bounding boxes, and generate a checksum. The source CRS is documented by SGIS. [SGIS small-area statistics manual](https://sgis.mods.go.kr/html/attachFiles/SGIS%20%EC%86%8C%EC%A7%80%EC%97%AD%20%ED%86%B5%EA%B3%84%20%EC%9D%B4%EC%9A%A9%EB%A7%A4%EB%89%B4%EC%96%BC.pdf)
5. **Validate before replacing the rectangle.** Require positive tests for mainland, Jeju, and the named island set; negative tests for surrounding seas and foreign land; and edge tests for exact polygon boundaries. Compare a sample of accepted points with Kakao `H/B` region results and KMA's official grid converter. [Kakao Local coordinate-to-region response](https://developers.kakao.com/docs/ko/local/dev-guide) · [KMA API Hub coordinate converter](https://apihub.kma.go.kr/apiList.do?apiMov=4.+%EB%8F%99%EB%84%A4%EC%98%88%EB%B3%B4%28%EC%B4%88%EB%8B%A8%EA%B8%B0%EC%8B%A4%ED%99%A9%C2%B7%EC%B4%88%EB%8B%A8%EA%B8%B0%EC%98%88%EB%B3%B4%C2%B7%EB%8B%A8%EA%B8%B0%EC%98%88%EB%B3%B4%29+%EC%A1%B0%ED%9A%8C&seqApi=10&seqApiSub=286)
6. **Use the validator for every entry path.** Apply the same server-side containment rule to browser GPS, manual Kakao selection, and direct forecast API calls. Only after containment succeeds should 오늘비 calculate the KMA cell or call weather providers.
7. **Add an update runbook.** Check the official package on its stated semiannual cadence, regenerate only from the official source, rerun the full geospatial corpus, review administrative changes, and ship the new checksum as a normal reviewed change. [Public Data Portal SGIS boundary package](https://www.data.go.kr/data/15129688/fileData.do)

## 4. Explicitly unresolved facts

These are release questions, not assumptions to encode:

- **Kakao attribution:** the official pages expose optional Map/Local logo resources but do not state the exact attribution required for a text-only address-result list. Ask Kakao Map/Local support. [Kakao Map resource page](https://developers.kakao.com/tool/resource/map) · [Kakao Map usage FAQ](https://developers.kakao.com/docs/ko/kakaomap/common)
- **Kakao cache TTL:** the policy limits purpose and freshness but supplies no numeric TTL for Local responses. Ask whether transient server caching is allowed and for how long. [Kakao Developers operating policy, Article 5](https://developers.kakao.com/terms/en/site-policies-20250304)
- **Kakao representative-point semantics:** no reviewed field contract defines what a bare `REGION` coordinate represents. Keep the UI's representative-point language and do not call it a centroid. [Kakao Local REST guide](https://developers.kakao.com/docs/ko/local/dev-guide)
- **Kakao Local burst limit:** `429` can mean quota or per-second exhaustion, but no Local-specific per-second number is published. [Kakao REST API reference](https://developers.kakao.com/docs/ko/rest-api/reference)
- **SGIS island completeness:** nationwide coverage is stated, but the source pages do not enumerate small islands or a minimum retained polygon area. Inspect the actual file and block release if the acceptance set is incomplete. [SGIS data catalogue](https://sgis.mods.go.kr/view/pss/openDataIntrcn)
- **SGIS asset size and runtime budget:** official metadata does not publish file bytes or vertex counts. Measure before selecting simplification or encoding. [Public Data Portal SGIS boundary package](https://www.data.go.kr/data/15129688/fileData.do)
- **SGIS API daily quota:** current official introduction and official terms conflict between unlimited calls and 50,000 calls per key per day. Avoid the runtime API or obtain written confirmation. [SGIS OpenAPI introduction](https://sgis.mods.go.kr/developer/html/newOpenApi/api/intro.html) · [SGIS OpenAPI terms](https://sgis.mods.go.kr/developer/html/newOpenApi/app/rules.html)
- **Boundary-date semantics:** the public package mixes 2025 boundaries with 2024 statistics. Use only the geometry and record its boundary vintage explicitly. [Public Data Portal SGIS boundary package](https://www.data.go.kr/data/15129688/fileData.do)
- **Small-island fallback:** no second geometry source should be merged until its license permits reprojection and derived deployment. The reviewed MOLIT cross-check source is Type 4 and therefore unsuitable for that fallback without permission. [MOLIT boundary machine metadata](https://www.data.go.kr/catalog/15125055/fileData.json)

## Final recommendation

Proceed with two bounded workstreams: first, credential and validate Kakao without adding persistence; second, replace the rectangle with a deterministic server-only SGIS boundary asset. Do not make Kakao reverse-geocoding or SGIS OpenAPI a runtime prerequisite for every GPS forecast. Promote the location flow from draft only after the Kakao matrix passes, the official geometry contains the island acceptance set, surrounding-ocean points are rejected, and the remaining Kakao attribution/cache questions have written answers.
