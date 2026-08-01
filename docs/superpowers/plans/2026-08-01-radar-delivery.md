# Radar Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Put Radar Timeline and Radar Frame delivery behind one deep module and remove the thirteen-request browser burst.

**Architecture:** A production RadarDelivery module owns window calculation, validation, readiness, admission, cancellation, same-key single-flight, immutable caching, and rendering. Existing HTTP routes remain adapters; presentation progressively warms frames with a bounded client loader.

**Tech Stack:** TypeScript, Node test runner, Next.js route handlers, KMA grid/geo/PNG modules, browser Image.

## Global Constraints

- Preserve thirteen observed frames at five-minute cadence, oldest to newest.
- Preserve successful PNG bytes, route paths, attribution, and non-secret failures.
- Invalid frame keys perform no KMA work.
- Request rate limiting stays in HTTP adapters; render admission lives in RadarDelivery.
- Add no remote cache and no dependency.

---

### Task 1: Build and test the RadarDelivery module

**Files:**
- Create: lib/radar/delivery.ts
- Create: lib/radar/delivery.test.ts
- Modify: lib/radar/kma.ts
- Modify: lib/radar/apihub.ts

**Interfaces:**
- Produces: createRadarDelivery(dependencies, options): RadarDelivery
- Produces: productionRadarDelivery
- Produces: timeline(signal?) and frame(key, signal?)

- [ ] **Step 1: Write failing interface, concurrency, and cancellation tests**

Use an in-memory KMA adapter with counters and deferred promises. Assert invalid keys do zero reads, same-key calls share one read, thirteen distinct calls never exceed maxConcurrent, aborted queued work returns cancelled, and capacity recovers after failure.

~~~ts
const delivery = createRadarDelivery(fakeDependencies, {
  now: () => now,
  maxConcurrent: 2,
  maxQueued: 16,
});
const results = await Promise.all(keys.map((key) => delivery.frame(key)));
assert.equal(maxObserved, 2);
assert.equal(results.filter((result) => result.kind === "ready").length, 13);
~~~

- [ ] **Step 2: Run focused tests and verify red**

Run: node --test lib/radar/delivery.test.ts

Expected: FAIL because the delivery module does not exist.

- [ ] **Step 3: Implement delivery orchestration**

Move allowed-key checking and timeline construction behind RadarDelivery. Add discriminated frame results ready, invalid, busy, cancelled, and unavailable. Implement keyed pending work plus bounded admission whose queue removes aborted entries and releases capacity in finally. Inject time and KMA reads at construction.

- [ ] **Step 4: Reuse pure render implementation**

Replace apihub.ts renderFrame with a production KMA radar adapter exposing configured(), bounds(signal?), and render(key, signal?). Its render implementation reuses the existing grid fetch, loadGeo, crop, reprojection, and PNG encoding without caching or admission. RadarDelivery wraps that adapter with the only render cache, single-flight map, and admission queue. Ensure timeline probes cross the same delivery path as direct frame calls.

- [ ] **Step 5: Run radar tests**

Run: node --test lib/radar/*.test.ts

Expected: PASS for delivery, KST keys, grid, geo, Mercator, and presentation.

- [ ] **Step 6: Commit the deep module**

~~~bash
git add lib/radar/delivery.ts lib/radar/delivery.test.ts lib/radar/kma.ts lib/radar/apihub.ts
git commit -m "refactor: own radar delivery in one module"
~~~

### Task 2: Make routes thin RadarDelivery adapters

**Files:**
- Modify: app/api/radar/frames/route.ts
- Modify: app/api/radar/frame/route.ts

**Interfaces:**
- Consumes: productionRadarDelivery.timeline and .frame
- Preserves: current JSON success and immutable PNG success contracts

- [ ] **Step 1: Update route mapping**

Pass request.signal into delivery calls. Map invalid to 400/no-store, busy to 503/no-store with Retry-After, cancelled to 499/no-store, unavailable to 502/no-store, and ready to image/png with immutable cache headers.

- [ ] **Step 2: Add route-level assertions to delivery tests**

Assert success remains cacheable and every failure is no-store. Keep rate-limit calls in routes and remove direct imports of kma validation/apihub rendering.

- [ ] **Step 3: Verify**

Run: npx tsc --noEmit

Expected: exit 0 and both routes depend only on rate limiting plus RadarDelivery.

- [ ] **Step 4: Commit route migration**

~~~bash
git add app/api/radar/frames/route.ts app/api/radar/frame/route.ts lib/radar/delivery.test.ts
git commit -m "refactor: route radar requests through delivery"
~~~

### Task 3: Add progressive client warming and honest failures

**Files:**
- Modify: lib/radar/presentation.ts
- Modify: lib/radar/presentation.test.ts
- Modify: components/atmosphere/sections/RadarSection.tsx

**Interfaces:**
- Produces: orderedRadarWarmup(frames, activeIndex): KmaRadarFrame[]
- Preserves: scrubber/playback behavior and reduced-motion gate

- [ ] **Step 1: Write failing warmup-order tests**

Assert active is first, next playback frame is second, remaining frames are unique, and empty/single-frame inputs are safe.

Run: node --test lib/radar/presentation.test.ts

Expected: FAIL because orderedRadarWarmup is absent.

- [ ] **Step 2: Implement ordering and progressive Image loading**

Add the pure ordering helper. Replace frames.map(new Image()) with one-at-a-time Image loading in the returned order. Advance on both load and error, cancel on effect cleanup, retain live Image references, and track failed keys. If the active key fails, select the nearest non-failed observed frame and show the existing unavailable presentation text.

- [ ] **Step 3: Verify presentation**

Run: node --test lib/radar/presentation.test.ts

Expected: PASS.

Run: npm run lint

Expected: exit 0.

- [ ] **Step 4: Commit browser behavior**

~~~bash
git add lib/radar/presentation.ts lib/radar/presentation.test.ts components/atmosphere/sections/RadarSection.tsx
git commit -m "fix: bound radar frame warmup"
~~~

### Task 4: Synchronize radar documentation

**Files:**
- Modify: README.md
- Modify: docs/weather-sources.md
- Modify: CLAUDE.md
- Modify: .env.example

- [ ] **Step 1: Describe the resulting module and limits**

Update the architecture diagram, radar engineering choice, source cache/failure row, implementation map, delivery invariant, and KMA key commentary. Remove outdated claims that a newest-frame probe guarantees later process-local cache hits.

- [ ] **Step 2: Verify stale language is absent**

Run: rg -n "preload every frame|warms the newest|Hobby.s max" README.md docs CLAUDE.md .env.example app lib/radar components

Expected: no stale operational claim.

- [ ] **Step 3: Commit**

~~~bash
git add README.md docs/weather-sources.md .env.example
git add -f CLAUDE.md
git commit -m "docs: describe radar delivery"
~~~
