# Korea-wide location continuation handoff

- **Snapshot:** 2026-08-15 KST
- **Resume branch:** `research/location-boundary-validation`
- **Starting commit:** `f89e280` (`fix: complete location search contract`)
- **Purpose:** let a new agent continue the Korea-wide location and local-accuracy work without reconstructing prior decisions.

## Resume sequence

1. Read this file, [`CONTEXT.md`](../../CONTEXT.md), [`docs/adr/0002-korean-location-selection.md`](../adr/0002-korean-location-selection.md), and both files under [`docs/research`](../research/).
2. Run `git status --short --branch`. Use `research/location-boundary-validation` as the read-only handoff checkpoint and account for every unexpected change before continuing.
3. Run `git fetch origin`, then `git rev-list --left-right --count origin/main...HEAD`. Reconcile genuine remote changes before editing.
4. Read live GitHub issues `#25` through `#29` with `gh issue view <number> --comments` before changing their state.
5. Verify the SGIS source package can be acquired and inspected. Select one implementation slice only after its completion criterion is satisfied.
6. Before implementation, create a new feature branch in the active agent session from this handoff checkpoint. Push only that newly created branch.

The resume sequence is complete when the agent has verified the checkout, current issues, research evidence, and the next slice without modifying code.

## Product direction

The product is no longer primarily “Seoul cinematic weather.” Its central promise is a Korea-wide forecast whose provider influence responds to recent measured performance.

- [Verified] Device geolocation is the closest available user-location input and remains distinct from a searched administrative area's representative point.
- [Verified] Text search supports Korean city/province, district/county, and neighborhood inputs through Kakao Local REST.
- [Verified] Weather forecasts use the selected coordinate, while KMA short-term forecasts are snapped to their forecast grid and performance evidence is tied to a separate observation station.
- [Verified] Recent performance changes precipitation-probability influence only when the evidence gate is active; otherwise the forecast uses equal influence.
- [Inferred] “Recent local accuracy” must remain conditional. Nationwide location selection must not imply that trustworthy local performance evidence exists everywhere.

## Delivered and merged

[PR #30](https://github.com/mhju0/seoulsky/pull/30) merged into `main` on 2026-08-15 as `f89e280`.

### Location search

- [Verified] [`lib/locationSearch.ts`](../../lib/locationSearch.ts) sends server-side Kakao address-search requests, keeps the REST key off the client, normalizes Korean input, handles aliases, retries a bare name with a `동` suffix, and returns fully qualified candidates.
- [Verified] Administrative and legal dong identities can be separate results when Kakao returns different names/codes, such as `삼성1동` and `삼성동`.
- [Verified] Full-hierarchy exact labels rank before fuzzy candidates.
- [Verified] Queries shorter than two characters and longer than 80 characters are rejected before an upstream request.
- [Verified] Street-address results do not enter the administrative-area picker.
- [Verified] The route at [`app/api/locations/search/route.ts`](../../app/api/locations/search/route.ts) applies a 20-request-per-minute in-process limiter, maps invalid queries to HTTP 400, maps excess requests to HTTP 429, and maps provider/configuration failures to HTTP 503.
- [Verified] Kakao responses have an 8-second total timeout and a 256 KiB JSON limit.

### Interaction and precision

- [Verified] [`components/local/LocalForecastExperience.tsx`](../../components/local/LocalForecastExperience.tsx) provides a 250 ms debounced autocomplete, request cancellation, stale-response suppression, keyboard selection, accessible combobox/listbox semantics, retry and empty states, and mobile result overflow.
- [Verified] Browser `coords.accuracy`, the KMA 5 km grid description, and observation-station distance are presented as separate precision concepts.
- [Verified] Device accuracy remains client-side and is not included in the forecast request body.
- [Verified] Administrative search is described as an area representative point rather than the user's exact position.
- [Verified] Raw precise coordinates are not used as the primary UI label.
- [Verified] [`forecastLocationCacheKey`](../../lib/location.ts) hashes the complete validated coordinate. The key hides coordinate text without claiming anonymity and does not intentionally merge nearby fixes.

### Domain and documentation

- [Verified] [`docs/adr/0002-korean-location-selection.md`](../adr/0002-korean-location-selection.md) records the location-selection contract and its pending gates.
- [Verified] [`CONTEXT.md`](../../CONTEXT.md) defines Location Candidate, Area Representative, and Device Location Selection.
- [Verified] [`docs/research/korean-location-search.md`](../research/korean-location-search.md) contains the pre-implementation provider and mainstream-weather-product research. Its “current baseline” section is historical and predates PR #30; do not treat the Open-Meteo description there as current production behavior.
- [Verified] README, weather-source, privacy, environment-example, and test-command documentation were updated with the implementation.

## Verification already completed

Before PR #30 was merged:

- [Verified] `npm run lint` passed.
- [Verified] `npx tsc --noEmit` passed.
- [Verified] `npm test` passed 341 library tests and 4 TSX/JSDOM component tests.
- [Verified] `npm run build` passed and emitted both local-forecast and location-search routes.
- [Verified] `npm audit --audit-level=moderate` reported zero vulnerabilities.
- [Verified] `git diff origin/main --check` passed.
- [Verified] CI, CodeQL, dependency review, and Vercel checks all passed; GitHub reported a clean merge state.
- [Verified] The final two-axis review found no remaining locally fixable contract finding after commit `f89e280`.

Re-run the gates after any new implementation. Prior green results are evidence for the merged checkpoint, not for future changes.

## Current checkout and work in progress

- [Verified] Local `main` was fast-forwarded to `origin/main` at `f89e280`.
- [Verified] `research/location-boundary-validation` was created from that commit and has not been pushed.
- [Verified] No implementation change has been made on the new branch.
- [Verified] Primary-source research is complete in [`docs/research/korea-location-production-readiness.md`](../research/korea-location-production-readiness.md). It covers Kakao production constraints, authoritative Korean boundary sources, KMA coordinate-to-grid behavior, and the validator recommendation.
- [Verified] The recommendation is to retain Kakao for manual search and generate a server-only containment asset from the latest official SGIS nationwide administrative-boundary file.
- [Verified] KMA coordinate conversion is projection only; its broad grid domain includes sea/non-observation cells and cannot validate South Korean land coverage.
- [Unknown] SGIS small-island completeness, raw/generated asset size, and runtime containment cost remain unknown until the actual SHP package is downloaded and measured.

The research checkpoint is complete. The acquisition checkpoint is complete only when the actual SGIS package's source URL, boundary vintage, retrieval date, checksum, included terms/readme, CRS, byte sizes, feature count, and required-island presence have been recorded.

## Current blockers and open issues

All five issues were still open when this handoff was written.

### [#25 — choose the Korea-wide location data contract](https://github.com/mhju0/seoulsky/issues/25)

- [Verified] Kakao is implemented as the initial server-side provider.
- [Verified] The credentialed live matrix has not run because a Kakao REST key was not available during implementation.
- [Unknown] Current production attribution, caching/retention, quota, and billing settings still require verification against the account's accepted terms and live console.
- [Verified] Required live inputs include `서울`, `서울시`, `수원시`, `제주시`, `강남구`, `수원시 영통구`, `서귀포시`, `삼성동`, `서울 강남구 삼성동`, and `신대방제2동`.

### [#26 — replace unreliable Korean administrative search](https://github.com/mhju0/seoulsky/issues/26)

- [Verified] The implementation and offline contract tests are merged.
- [Unknown] Close only after comparing its current acceptance criteria with merged code and recording the missing credentialed matrix as either a blocker in #25 or an explicit residual item.

### [#27 — neighborhood autocomplete and disambiguation](https://github.com/mhju0/seoulsky/issues/27)

- [Verified] Autocomplete, duplicate labels, keyboard interaction, stale-response handling, retry states, and focused component tests are merged.
- [Unknown] A real-browser visual and assistive-technology pass was not available in the prior environment. Verify the current issue's acceptance criteria before closing.

### [#28 — precision and exact-coordinate protection](https://github.com/mhju0/seoulsky/issues/28)

- [Verified] Accuracy display, representative-area language, coordinate hashing, privacy copy, and unsupported outer-bounds tests are merged.
- [Verified] [`createForecastLocation`](../../lib/location.ts) still uses one rectangle: latitude `32.75–38.65`, longitude `124.5–132`.
- [Verified] That rectangle admits ocean and coordinates outside the intended South Korean land/service area. Replacing it is the remaining production correctness task.
- [Inferred] Do not solve this with a hand-authored mainland polygon or tighter rectangle; either approach risks excluding inhabited islands while retaining false coverage.

### [#29 — nationwide forecast-verification coverage](https://github.com/mhju0/seoulsky/issues/29)

- [Verified] Production evidence currently uses KMA ASOS stations with a maximum station distance of 100 km and an elevation-difference gate when both elevations are known.
- [Verified] The issue requires national coverage counts, elevation/missing-elevation analysis, AWS evaluation, a new policy recommendation, UI language, and an ADR before changing weighting.
- [Verified] No nationwide coverage analysis or station-policy change has been implemented.
- [Inferred] Keep equal influence as the honest fallback. Do not loosen station gates merely to make more locations appear “local.”

## Time-sensitive administrative finding

- [Verified] The `광주` mapping to `전남광주통합특별시` in [`lib/locationSearch.ts`](../../lib/locationSearch.ts) is intentional for this 2026-08-15 snapshot.
- [Verified] The official installation law is effective from 2026-07-01: [전남광주통합특별시 설치를 위한 특별법](https://www.law.go.kr/LSW/lsRvsDocListP.do?chrClsCd=010202&lsId=015064&lsRvsGubun=all).
- [Inferred] Provider rollout can lag legal changes. The credentialed matrix should explicitly test both the user alias and Kakao's returned canonical region name rather than deleting the current mapping based on older geographic knowledge.

## Recommended next implementation slice

Choose exactly one branch after attempting the SGIS acquisition checkpoint. Branch A is preferred; use Branch B when the authoritative package or its island/terms evidence cannot be obtained safely.

### Branch A — authoritative service-area validation

Use this branch only after the official SGIS package has been acquired and its actual geometry confirms the required island set. The catalogue's nationwide description alone is insufficient.

1. Inspect the SGIS SHP in EPSG:5179 for Jeju, Udo, Chuja, Mara, Ulleungdo, Dokdo, Baengnyeongdo, Daecheongdo, Yeonpyeongdo, and Heuksando; stop if intended coverage is missing.
2. Add discriminating tests before production code: accepted mainland and required islands; rejected North Korea, Japan, Yellow Sea, Korea Strait, and East Sea points.
3. Deterministically reproject to WGS84 while retaining multipolygon parts and holes. Generate a checksummed server-only asset with bounding boxes; keep raw SHP outside the runtime bundle.
4. Implement one deep validator seam in [`lib/location.ts`](../../lib/location.ts); keep `createForecastLocation` as its caller.
5. Record source version/update procedure near the data, then measure source/generated bytes, bundle impact, cold-start impact, and containment latency before considering simplification.

Completion criterion: every test point is justified by the authoritative source, islands remain supported, false rectangle admissions reject, and the full gate suite passes.

### Branch B — credentialed Kakao matrix harness

Use this branch if the boundary source or its terms remain unresolved.

1. Add a focused, manually invoked verifier for the #25 query matrix; keep the key server-only and read it from the existing environment name.
2. Report labels, administrative/legal kinds, and pass/fail expectations without printing the key or unnecessary coordinates.
3. Unit-test matrix evaluation with fixtures, including ambiguous `삼성동` and the 2026 Gwangju/Jeonnam canonical name.
4. Document the exact command and distinguish “harness passes unit tests” from “credentialed matrix passed live.”

Completion criterion: the harness fails on incomplete/wrong provider results, succeeds on representative fixtures, never exposes credentials, and produces an auditable live report once a key is supplied.

## Later research sequence for #29

Begin only after the location contract and service boundary are settled.

1. Acquire an authoritative nationwide 읍/면/동 representative-point dataset and current KMA station catalogue.
2. Produce counts within 10, 25, 50, and 100 km for every representative point.
3. Add elevation availability/difference, island/coast, and terrain limitations.
4. Evaluate KMA AWS history and quality controls from first-party documentation.
5. Recommend active-local, regional, collecting, and unavailable evidence states.
6. Write an ADR, then change station policy and UI only if evidence supports it.

Completion criterion: every supported area is counted exactly once, missing data is explicit, results are reproducible from versioned inputs, and policy follows the evidence rather than a desired coverage percentage.

## Security, privacy, and performance guardrails

- Keep `.env.local` and every live key out of output, fixtures, diffs, and commits. It contains sensitive configuration unrelated to this handoff.
- Use `KAKAO_REST_API_KEY` only server-side; preserve bounded response reading, timeout, request cancellation, stale-response suppression, and rate limiting.
- Treat the deterministic coordinate hash as an opaque cache identity, not anonymization.
- Preserve the distinction between device accuracy, representative search points, forecast-grid resolution, and station distance.
- Avoid application logs containing raw precise coordinates or residential search strings.
- Keep exact GPS reverse geocoding opt-in as an explicit privacy decision; the current design labels it `현재 위치` without sending it to a second geocoder.
- Do not change scoring or station eligibility until #29's evidence and ADR exist.
- Do not add or change licensing.

## Repository delivery rules

- Tag codebase claims `[Verified]`, `[Inferred]`, or `[Unknown]` in reports.
- Use `apply_patch` for edits and explicit paths for `git add`; never use `git add .`.
- Keep each commit coherent and use an English Conventional Commit message.
- Push only a feature branch created in the active session. Never push `main`, rewrite history, or force-push.
- Preserve unrelated worktree changes and generated reliability-state history.
- For a bug fix, demonstrate a failing regression test before implementation. For a refactor, show green tests before and after.
- Before a PR, run the two-axis standards/spec review, resolve every locally actionable finding, and state external blockers honestly.

## Verification and delivery commands

Run separately after the selected slice is complete:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
npm audit --audit-level=moderate
git diff --check
```

Then inspect `git diff --stat`, the full diff, `git status --short --branch`, and the remote comparison before committing or pushing. Never include `.env.local` in any command that stages or prints file content.

## Definition of the next successful handoff

The next agent should leave one of two concrete outcomes:

- an authoritative, tested Korea service-area validator with documented source/update behavior; or
- a verified Kakao matrix harness plus a research-backed explanation of why boundary implementation remains blocked.

In either outcome, commit the research separately from code, update the relevant GitHub issues with evidence, keep unresolved release gates visible, and open a draft PR only after local and GitHub checks pass.
