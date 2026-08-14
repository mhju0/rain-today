# Korea-wide city, district, and neighborhood search research

**Status:** research complete; Kakao implementation pending credentialed matrix validation

**Researched:** 2026-08-14

**Scope:** a SeoulSky location picker that accepts Korean city (`시`), district (`구`/`군`), and neighborhood (`동`, including administrative and legal dong) inputs and returns a coordinate for weather. This report uses product-owner pages and live first-party product observations only. It does not authorize scraping a weather site or select a vendor contract.

## Executive finding

Korea-wide neighborhood search should treat a typed place as an **ambiguous selectable result**, not as a coordinate claim. A selected result should retain a display label, WGS84 latitude/longitude, and—when returned—the administrative and legal-area codes. That resolves common duplicate names such as `삼성동` safely. [Verified] It also fits the current forecast path, which ultimately requires a validated coordinate.

For one hosted search provider, Kakao Local REST has the fullest documented fit: address-to-coordinate results include `시/도`, `구`, `동`, administrative and legal codes, and its coordinate-to-region endpoint can canonicalize the chosen point. NAVER Cloud Maps is a strong alternative for structured address geocoding: it supports `HCODE`/`BCODE` filters and returns address elements through `DONGMYUN`; its public Maps product does not document an equivalent general place-keyword endpoint. The government road-name service and the government legal-dong code catalogue are authoritative complements, but neither alone is a complete free-text `동`-centroid resolver.

This is not a conclusion that one provider is legally cleared for SeoulSky. Obtain and review the selected provider's current agreement before implementation, keep any key server-side, and do not persist a user query or selected coordinate unless the product/privacy design is deliberately changed.

## What Korean weather products currently do

The following claims are **observed UI behavior** from the referenced first-party pages, not assertions about their undocumented search APIs or ranking algorithms.

| Product | Observed location behavior | What the observation does *not* establish |
| --- | --- | --- |
| KMA WeatherNuri | The location chooser visibly drills through `시/도`, `구/군`, and `읍면동`, and has a separate road-name-address mode. Its help text says the main search can select land-weather locations from `읍면동` plus major buildings, named mountains, and parks. It supports up to ten favorite locations saved in browser cache. [WeatherNuri live page/help](https://www.weather.go.kr/w/index.do) | Its public page does not document a reusable search API, matching rules, centroid policy, or license to reuse the results. |
| NAVER Weather | The live HTML exposes a location search field with the placeholder “지역을 검색해 보세요”, “최근 본 지역”, current-location controls, and a favorite-location action. [NAVER Weather](https://weather.naver.com/today/09140104?cpName=KMA) | The publicly visible page did not expose a first-party statement of which administrative levels the weather search accepts, its ranking, or a public API for reproducing it. Treat any inference beyond the visible UI as undocumented. |
| Daum Weather (Kakao) | Daum's customer help explicitly says the weather search supports both legal and administrative dong names; the upper-right search also shows recent regions, which are stored in browser cookies and can be disabled/deleted. The service favors recently viewed regions; without one it describes a default of Cheongunhyoja-dong, Jongno-gu, Seoul. Its location help distinguishes IP-based PC approximation from browser/GPS-enabled mobile location. [Daum: search and recents](https://cs.daum.net/faq/service/2438/category/67092/detail/39073) · [Daum: current location](https://cs.daum.net/faq/service/2438/category/67092/detail/39072) | This establishes the product behavior, not that SeoulSky may call Daum weather or reuse its region IDs/data. |
| AccuWeather (global) | A Korea page is served for `Dongjak-dong, Seoul`; its location switcher offers current location, recent locations, and instructs people to search by city, ZIP code, or point of interest. The same page links nearby `Dongjak-gu` and Seoul pages. [AccuWeather: Dongjak-dong](https://www.accuweather.com/en/kr/dongjak-dong/3353755/current-weather/3353755) | The UI confirms Korea neighborhood and district coverage in at least this example; it does not prove coverage/completeness for every Korean dong or a licensed search endpoint. |

### Product patterns worth carrying forward

1. **Support layered administrative names, not cities only.** WeatherNuri and Daum explicitly operate at 읍면동/legal-or-administrative-dong level, and the AccuWeather example confirms that a global service can surface a Korean `-dong` page.
2. **Use select-before-change.** All evidence points to search results being selected locations, rather than weather being immediately claimed for the raw string.
3. **Separate typed search from current location.** Both WeatherNuri and Daum do this; Daum also describes the accuracy limitations of IP/GPS modes.
4. **Make recents local and disposable.** WeatherNuri uses browser cache and Daum uses cookies. [Verified] A local-only recent list is consistent with the repository's current UI statement that user coordinates are not persisted.

## Current SeoulSky baseline and precision limits

- [Verified] The production endpoint currently delegates Korean search to Open-Meteo Geocoding with a small hard-coded city alias table. It requires two characters, requests eight Korean results, and accepts only results marked `KR`. [`lib/locationSearch.ts`](../../lib/locationSearch.ts)
- [Verified] Live production checks on 2026-08-14 show that `강남구` resolves incorrectly to `강남구렁고개` in Buyeo, while `서울시` and `역삼` return no result. `역삼동` returns candidates with mixed Korean/English names. This establishes a correctness defect in the current country-wide search, not only a missing autocomplete interaction. [SeoulSky location search](https://seoulsky.vercel.app/api/locations/search?q=%EA%B0%95%EB%82%A8%EA%B5%AC)
- [Verified] Browser geolocation sends the device coordinate to the forecast endpoint, but text search selects a provider-supplied representative coordinate. Neither path currently carries the browser's reported horizontal accuracy into the forecast response. [`components/local/LocalForecastExperience.tsx`](../../components/local/LocalForecastExperience.tsx)
- [Verified] KMA forecasts are mapped to a 5 km grid, and SeoulSky's recent-performance layer currently allows the nearest eligible observation station to be as far as 100 km away. A precise GPS coordinate therefore does not imply street-level forecast or verification precision. [`lib/location.ts`](../../lib/location.ts) · [`lib/localForecast.ts`](../../lib/localForecast.ts)
- [Inferred] The UI should state these separately: device-location accuracy, selected administrative area's representative point, forecast-grid resolution, and observation-station distance.

## Authoritative Korean reference data and services

### 1. Ministry of the Interior and Safety (MOIS) road-name address services

The official Address Information service has two relevant APIs:

- The [road-name address Search API](https://eng.juso.go.kr/addrlink/openApi/searchApi.do) requires an issued `confmKey`, page parameters, and a keyword. It returns canonical road-name/jibun address fields and administrative, road, and building identifiers. Its own validation rules reject a province-only query and a one-character query, so it is not sufficient by itself for a bare city/province picker. It supports address history (`hstryYn`), which can help an address-entry flow reconcile changed addresses.
- The [address-coordinate API](https://www.data.go.kr/data/15056663/openapi.do) takes the administrative code, road code, ground/underground flag, and building numbers returned by the first search, then returns `X`/`Y` coordinates and a building name. The government catalogue describes it as free, unrestricted in license scope, and automatically approved for both development and operation; it says traffic varies by agency policy. That is authoritative for a **building/road address** workflow, not evidence that it returns a representative coordinate for a bare `강남구` or `삼성동`.

The official [legal-dong code catalogue](https://www.code.go.kr/stdcode/regCodeL.do) lists national statutory-dong codes and hierarchy (for example, Seoul → Jongno-gu → Cheongun-dong), exposes current/abolished status, and supports downloadable/searchable code data. Its current page lists 20,560 entries. Use it as a maintenance-aware reference/validation dataset, not as evidence of administrative-dong equivalence: statutory (법정동) and administrative (행정동) are distinct concepts.

**Planning implication:** Use MOIS first when the promise is an address search and its two-call code-to-coordinate flow is acceptable. It does not remove the need for an administrative-dong source/centroid policy.

### 2. Kakao Local REST API

**Capability.** The [Local REST guide](https://developers.kakao.com/docs/ko/local/dev-guide) documents `GET /v2/local/search/address.{FORMAT}` for road-name and land-lot address geocoding. It accepts a `query`, defaults to broader `similar` matching (with `exact` available for exact building-name address patterns), and returns WGS84 `x` (longitude) and `y` (latitude). Address records supply first-, second-, and third-depth region names (시도/구/동), the administrative-dong name, plus `h_code` and `b_code`. The same documentation's `coord2regioncode` endpoint returns both administrative (`H`) and legal (`B`) region records for a selected coordinate.

For a broader place fallback, `GET /v2/local/search/keyword.{FORMAT}` returns place name/category, land-lot and road addresses, WGS84 coordinates, and a Kakao place URL. It can accept an `x,y,radius` context (radius up to 20 km) or a rectangle. Its `same_name` metadata reports which region strings it recognized, the remaining keyword, and the region it chose—useful diagnostic metadata, but not a contract that a bare `동` will always resolve as a neighborhood.

**Auth and public limits/cost.** Requests use `Authorization: KakaoAK ${REST_API_KEY}`; the key must remain on the server. Kakao's [quota page](https://developers.kakao.com/docs/en/getting-started/quota) currently lists 100,000 daily calls each for address geocoding, coordinate-to-region, and keyword-place search, with free Map quotas limited to the first Map-enabled app on a developer account. It lists paid price points of ₩0.5 per address/coordinate conversion and ₩2 per keyword/category search, subject to change. It also gives a 3,000,000-call monthly free quota for all APIs and states that amounts/limits may change; verify the activated application's live quota and wallet policy before relying on either figure.

**Usage/privacy constraints.** Kakao's [developer terms](https://developers.kakao.com/terms/latest/en/site-terms) prohibit using service-obtained data outside the approved means, copying/redistributing it to others without approval, and require compliance with applicable personal-information law. The Local documentation links a separate [Kakao Map usage policy](https://developers.kakao.com/docs/ko/kakaomap/common), which must be read at implementation time for caching, display, and branding requirements. This research did not find a REST-response attribution field; do not infer that no attribution is required. Do not send an exact home address until the applicable terms and SeoulSky privacy disclosures have been reviewed.

### 3. NAVER Cloud Maps Geocoding

**Capability.** NAVER's [Geocoding API](https://api.ncloud-docs.com/docs/en/ai-naver-mapsgeocoding-geocode) is an address-to-coordinate endpoint. It requires `query`, can rank results near an optional `longitude,latitude`, and can constrain results with `HCODE` (administrative dong) or `BCODE` (legal dong) filters. It permits Korean or English output and a page size up to 100. The [Maps product description](https://www.ncloud.com/api-cms/service-product/static/maps) says Geocoding returns detailed data with a coordinate for an entered address, while Reverse Geocoding returns legal dong, administrative dong, jibun, and road-name address.

**Auth and public cost.** The API calls use an NCP client ID and client secret (`x-ncp-apigw-api-key-id` and `x-ncp-apigw-api-key`); register a Maps application and enable the chosen API. NAVER's current public price table lists 3,000,000 monthly free Geocoding calls and the same for Reverse Geocoding, each for one representative account; usage over that displayed range is shown without a public price, so it needs direct confirmation before launch. The table labels usage pricing as request-count based and VAT-exclusive. [NAVER Maps pricing](https://www.ncloud.com/api-cms/service-product/static/maps)

**Important scope limit.** NAVER's current Maps documentation covers **address** geocoding. It does not document a Kakao-equivalent general POI keyword-search REST endpoint. NAVER Developers' separate Local Search is for businesses/institutions, not an administrative-boundary geocoder, and its product/migration status should be evaluated separately. Do not make an undocumented live-NAVER-weather-search call from SeoulSky.

**Usage/privacy constraints.** The Maps prerequisite guide says use of a non-official call path is abuse that may restrict access and requires Maps feature/service names to be displayed as documented. [NAVER Maps prerequisites](https://guide.ncloud-docs.com/docs/en/maps-spec) The NCP agreement and privacy policy are linked from the service documentation; use the version accepted by the eventual account. Like Kakao, its credentials belong server-side and a residential address is still user-supplied data sent to a processor.

## Normalization and canonical result design

### Inputs to support

Accept normalized Unicode Korean text and trim/collapse spaces, without stripping meaningful administrative suffixes. Target these shapes:

- `서울`, `수원시`, `제주시` (city/province-level inputs)
- `강남구`, `수원시 영통구`, `서귀포시` (district/county/city inputs)
- `삼성동`, `서울 강남구 삼성동`, `신대방제2동` (neighborhood inputs)
- road-name and land-lot addresses, as a deliberate extension (`서울 강남구 테헤란로 152`, etc.)
- named POIs only if the provider's separately documented POI endpoint is intentionally enabled.

Never promote a raw `동` to a single result without a qualifier: identical dong names exist nationwide. Rank exact full hierarchy above a bare leaf name, display enough hierarchy to distinguish it, and require a click/tap.

### Result model (planning contract)

Return only the selected search result to the existing forecast-location constructor:

```ts
type KoreanLocationCandidate = {
  id: string; // provider-scoped, never assumed cross-provider stable
  label: string; // e.g. "서울특별시 강남구 삼성동"
  latitude: number; // WGS84
  longitude: number; // WGS84
  kind: "administrative-area" | "legal-area" | "address" | "place";
  administrativeCode?: string;
  legalCode?: string;
  source: "kakao" | "naver-maps" | "mois";
};
```

[Verified] The current repository converts only validated WGS84 coordinates to the KMA grid and supplies those coordinates to weather providers. Therefore this search should be an upstream resolver; it should not change weather-provider behavior or make a KMA grid cell appear to be an exact neighborhood forecast. [Verified] The current UI says user coordinates are not persisted; local recents should remain a browser-only enhancement unless privacy policy and storage design are deliberately revised.

## Recommended implementation decision to validate later

1. **Primary path: Kakao Local address search, server-side.** Debounce after at least two Korean characters; send the raw query only to the server route; return at most a small selectable list. For address/area-looking results, show the full hierarchy. On selection, call coordinate-to-region only when canonical `H`/`B` metadata is missing or needs verification.
2. **Address-only alternative: NAVER Cloud Maps.** Use when product/account terms favor NAVER. Use its documented `HCODE`/`BCODE` filters to narrow an already-disambiguated result. Do not represent it as arbitrary place search.
3. **Government augmentation, not a bare-dong solution.** Use MOIS search + coordinate only for road-name/jibun inputs and statutory-code reference data for validation/migrations. Decide and document a representative-coordinate policy before offering an administrative-dong result from a code catalogue.
4. **Keep Open-Meteo as an explicit fallback only if required.** [Verified] The current code uses Open-Meteo's Korea-filtered endpoint for manual place search, but it is not the researched solution for `시/구/동` coverage. Avoid blending incomparable result sources without a result model and duplicate policy.
5. **Privacy and operations gate before implementation.** Do not log query strings or precise selected locations; keep API keys server-only; apply a short, documented search-result cache only if vendor terms permit it; retain required provider credit/branding; and update SeoulSky's sources/privacy documentation with the chosen vendor, data flows, cache duration, and failure state.

## Decision test matrix for the implementation phase

The product should not ship until a test suite verifies the displayed result and WGS84 coordinate for at least:

| Case | Why it matters |
| --- | --- |
| `서울`, `수원시`, `제주시` | Metropolitan/city/Jeju naming variants |
| `강남구`, `수원시 영통구`, `서귀포시` | `구`, embedded `시 + 구`, and city-like county-level name |
| `삼성동` and `서울 강남구 삼성동` | Duplicate leaf name requires disambiguation |
| `신대방제2동` | Administrative-dong suffix/number |
| a road-name and a jibun address | Provider's documented address normalization |
| a selected point followed by canonicalization | Legal versus administrative-dong code behavior |
| browser geolocation rejection/out-of-Korea coordinate | Manual search still works; existing Korea validation remains authoritative |
| no provider result/rate limit/provider failure | Honest empty/unavailable state; no fabricated coordinate |

## Source list

All sources below are first-party product, documentation, government, or legal pages, accessed 2026-08-14.

- [KMA WeatherNuri live UI and help](https://www.weather.go.kr/w/index.do)
- [KMA short-range forecast API and 5 km grid description](https://www.data.go.kr/data/15084084/openapi.do)
- [NAVER Weather](https://weather.naver.com/today/09140104?cpName=KMA)
- [Daum Weather search/recent-locations help](https://cs.daum.net/faq/service/2438/category/67092/detail/39073)
- [Daum Weather current-location help](https://cs.daum.net/faq/service/2438/category/67092/detail/39072)
- [AccuWeather Dongjak-dong, Seoul](https://www.accuweather.com/en/kr/dongjak-dong/3353755/current-weather/3353755)
- [MOIS road-name Search API](https://eng.juso.go.kr/addrlink/openApi/searchApi.do)
- [MOIS address-coordinate API](https://www.data.go.kr/data/15056663/openapi.do)
- [MOIS legal-dong code catalogue](https://www.code.go.kr/stdcode/regCodeL.do)
- [Kakao Local REST documentation](https://developers.kakao.com/docs/ko/local/dev-guide)
- [Kakao quotas and prices](https://developers.kakao.com/docs/en/getting-started/quota)
- [Kakao developer terms](https://developers.kakao.com/terms/latest/en/site-terms)
- [Kakao Map common/usage documentation](https://developers.kakao.com/docs/ko/kakaomap/common)
- [NAVER Cloud Maps Geocoding API](https://api.ncloud-docs.com/docs/en/ai-naver-mapsgeocoding-geocode)
- [NAVER Maps product and price table](https://www.ncloud.com/api-cms/service-product/static/maps)
- [NAVER Maps prerequisites](https://guide.ncloud-docs.com/docs/en/maps-spec)
- [Korea Act on the Protection and Use of Location Information](https://elaw.klri.re.kr/eng_mobile/viewer.do?hseq=61450&key=ACT+ON+THE+PROTECTION+AND+USE+OF+LOCATION+INFORMATION&type=lawname)

For current-location collection, Korea's Location Information Act describes personal location information, requires prior terms/consent for collection or location-based service provision, requires a stated purpose/retention period, and recognizes withdrawal/suspension rights. The exact regulatory application depends on the eventual implementation and must be reviewed before shipping; this is not legal advice. [Act, Articles 18–19 and 24](https://elaw.klri.re.kr/eng_mobile/viewer.do?hseq=61450&key=ACT+ON+THE+PROTECTION+AND+USE+OF+LOCATION+INFORMATION&type=lawname)
