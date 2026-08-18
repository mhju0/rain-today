---
status: accepted
---

# Keep device locations distinct from searchable Korean areas

오늘비 offers two location paths: browser geolocation produces a Device Location Selection, while typed `시/도`, `시/군/구`, or `읍/면/동` text produces selectable, fully qualified Location Candidates. A candidate may identify an administrative or legal area, but its coordinate is always an Area Representative rather than the user's position. Street addresses, POIs, automatic reverse geocoding, saved locations, and blended search providers are outside the initial surface.

## Considered options

- Kakao Map Local REST: best documented hosted fit for Korean hierarchy fields, WGS84 coordinates, and administrative/legal codes, but it requires a server key and provider-specific release validation.
- NAVER Cloud Maps: strong structured geocoding, but no equivalent documented general place-keyword surface in its Maps product.
- Maintained government index: avoids runtime vendor dependency, but requires a complete authoritative representative-coordinate source and an ongoing reorganization pipeline.

## Consequences

The initial adapter uses Kakao behind the existing server route and keeps its credential server-only. It is not release-ready until the credentialed matrix in issue #25 passes and current terms are reviewed. Results retain a source-scoped ID, fully qualified Korean label, WGS84 coordinate, area kind, available administrative/legal codes, and source. Exact hierarchy matches rank before fuzzy candidates; duplicate leaves remain separate selections. Provider results are never mixed with a fallback source. Local aliases and fixtures must be reviewed whenever an official Korean administrative reorganization takes effect and before a nationwide release.
