---
status: accepted
---

# Keep the two precipitation-scoring pipelines separate for now

오늘비 runs two pipelines that score provider precipitation accuracy and turn the result into bounded provider weights. `lib/reliability/` scores one station (서울 108) with an online Hedge update, persists to the `reliability-state` branch, and feeds the live Sky snapshot. `lib/performance/` scores every eligible station with batch Brier scoring split by Capture Cohort, persists to PostgreSQL, adds a Prospective Benchmark and Benchmark Suspension, and feeds the local forecast. They run on the same daily cron, neither reads the other, and a user can see two independently learned precipitation blends in one product.

They also share a vocabulary and a contract. Both define equal weights, renormalization, a 0.1 mm rain threshold, a 50% decision threshold, a 0.05 weight floor, a 0.6 weight cap, an Equal Fallback mode, a ramp from a warm-up count to full confidence, and a `normalizeClamped` with the same name and the same signature. Read as source, they look like one concept implemented twice.

## Decision

Do not merge them yet. Keep both implementations, and record why with an executable test rather than a comment.

## Considered options

- **Extract one shared scoring and weight-projection module, keeping persistence and cadence as adapters.** This is what a reading of the two files suggests, and it was the original proposal. Measurement rejected it — see below.
- **Extract only the identical primitives** (equal weights, renormalize) and the shared constants. Behaviour-preserving, but it couples two pipelines whose tuning may legitimately need to diverge, in exchange for roughly fifteen lines. The coupling is a larger commitment than the duplication it removes.
- **Keep both, pin the divergence with a test, and gate consolidation.** Chosen.

## Why measurement rejected the merge

The two `normalizeClamped` implementations are not the same function. `lib/performance/` water-fills: it seats every provider at the floor, then distributes the remaining mass in proportion to raw score, capping as it goes. `lib/reliability/` iterates renormalize-and-clamp to a fixed point.

Across a 200,000-case sweep over 2–5 sources, the two disagreed on about 78% of inputs, with a maximum single-weight difference of 0.167. That is a policy difference, not floating-point noise. For raw scores `{0.96, 0.036, 0, 0}`, water-filling returns `{0.6, 0.3, 0.05, 0.05}` while the fixed-point iteration returns `{0.6, 0.133, 0.133, 0.133}` — it levels the unscored sources up to the level of a source that was scored and did poorly.

Both satisfy the contract they document: across 100,000 cases neither violated sum-to-one, the floor, the cap, or the raw ordering. Neither is a bug. They are two defensible policies, so replacing either one changes served influence for real users.

## Consequences

Consolidation is a scoring change and inherits the gate that already applies to scoring: it must wait for the nationwide station-coverage evidence in issue #29 and an ADR that picks a projection policy deliberately. Picking one silently during a refactor would move every user's provider influence with no evidence and no record.

`normalizeClamped` is exported from `lib/performance/performance.ts` so the contract is testable from outside. `lib/precipWeightContract.test.ts` asserts what the two pipelines genuinely share — the bounded simplex and the ordering guarantee — and asserts that they still disagree, so a future change that quietly makes them identical fails and sends the author here.

Until that decision is made, the duplication stays visible and deliberate. Changing a shared constant in one pipeline does not change it in the other, and that remains a real hazard; the contract test does not cover it.

## Amendment, 2026-08-22 — one premise is now false, the decision is not

Retiring `/api/sky` (#71) removed the HTTP path that served `lib/reliability/`'s learned
weights. Issue #63 asked whether that reopens the projection-policy question this record
gated.

**One sentence above is no longer true.** "Replacing either one changes served influence
for real users" held while both pipelines fed a route. Only `lib/performance/` does now,
so replacing `lib/reliability/`'s fixed-point iteration would move nobody's forecast.

**The decision stands anyway, for a different reason.** The gate above was never only
about blast radius; it was about not picking a projection policy silently. That reason is
untouched. Water-filling remains the served policy by inheritance, not by evidence — it
was never chosen over the alternative, and the 78% disagreement above is exactly the
measurement that says the choice is real. Retiring the loser of a comparison nobody ran
does not settle it.

Two consequences follow:

- **`lib/precipWeightContract.test.ts` stays.** Its subject is the divergence, and the
  divergence still exists in the tree; [ADR 0007](./0007-keep-the-unread-reliability-pipeline.md)
  keeps `lib/reliability/` running. The test would only become pointless if one
  implementation were deleted, and nothing is being deleted.
- **The gate's blocker moves.** It named issue #29, which is now closed — the
  nationwide coverage evidence exists and produced
  [ADR 0005](./0005-station-proximity-is-language-not-eligibility.md). Consolidation now
  waits on the 2026-09-18 revisit in ADR 0007, which is the point at which the two
  pipelines will have learned enough at the same time to be compared on outcomes rather
  than on synthetic sweeps. That comparison, not a refactor, is what should pick a
  projection policy.

This record is otherwise unchanged and remains accepted.
