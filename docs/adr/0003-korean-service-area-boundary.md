---
status: accepted
---

# Validate the service area against official boundary geometry

A forecast coordinate is admitted only when it falls on South Korean land in the official SGIS 시도 boundary set, replacing the launch rectangle of latitude 32.75–38.65 and longitude 124.5–132. The rectangle admitted open sea, North Korean territory such as 개성, and Japanese territory such as 대마도, which made "exact-coordinate forecast" a claim the validator could not support. Geometry is generated offline into a server-only asset; the runtime performs containment only.

## Considered options

- Official SGIS 시도 boundaries: nationwide, versioned, free, downloadable without credentials, and published with no stated usage restriction. Verified to contain every required island including 마라도, 울릉도, 독도 동도/서도, 백령도, 대청도, 연평도, 추자도, and 흑산도.
- MOLIT/VWorld census boundaries: usable as a cross-check, but Korea Open Government License Type 4 forbids modification and commercial use, which conflicts with reprojection and derived deployment.
- SGIS boundary OpenAPI: avoids a bundled asset, but requires a renewable token and its official introduction and terms disagree about the daily request limit, so it is unsafe as a runtime dependency.
- A tighter rectangle or hand-drawn polygon: rejected. Either excludes inhabited islands or retains false coverage, and neither is traceable to an authoritative source.
- KMA coordinate-to-grid conversion: rejected as a validator. It projects any coordinate in a broad numeric domain onto the nearest grid cell, including sea cells, so a successful conversion proves nothing about land or service coverage.

## Consequences

`createForecastLocation` delegates to a single containment seam and keeps its existing error contract, so every entry path — browser geolocation, administrative search selection, scheduled station capture, and direct API calls — is validated identically before any KMA grid conversion or provider request. Containment runs before grid conversion; a coordinate on land whose grid cell has no data must still surface an honest unavailable result rather than a fabricated forecast.

Geometry stays grouped by feature and containment is decided by ring-nesting parity within each feature. This is load-bearing, not an implementation detail: 전라남도 encloses 광주광역시, so 전남's polygon carries a hole exactly where that city sits. Evaluating holes across the whole layer rejected every coordinate in 광주 — a city of 1.4 million and the location of KMA ASOS station 156 — while still passing an island-only test corpus. The regression tests therefore assert a representative point for all 17 시도 and specifically for 광주, so a province cannot silently drop out again.

The asset is derived from the 2025-06-30 boundary vintage, simplified with a 10 m Douglas-Peucker tolerance capped at one eighth of each ring's extent so small islands keep their shape, and quantized to about 1.1 m. Measured against the unsimplified geometry, disagreement is confined to within roughly 25 m of the coastline — far inside the 5 km KMA forecast grid and typical device GPS accuracy — and no required island or rejection case changes. This bound is a documented product limit, not an unbounded approximation.

The encoded geometry costs about 0.9 MB, decoding about 9 ms once per process, and about 57 µs per validation. It must remain server-side; shipping nationwide geometry to the browser is not acceptable. Because the source is published semiannually, the boundary vintage, checksums, and island corpus must be re-verified on every regeneration, and the source package must never be committed. This vintage predates the 2026-07-01 전남광주통합특별시 installation, so it must not be used as a source of current administrative names; that remains a separate question in the location-search contract.
