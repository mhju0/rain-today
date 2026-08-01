# Durable Reliability Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Publish each validated Reliability Snapshot atomically to a dedicated reliability-state branch without creating Vercel deployments.

**Architecture:** One transaction module owns restore, optional recovery, the daily cycle, validation, remote-tip comparison, and publication. A Git adapter implements the real branch seam and is verified against a local bare repository; workflow and runtime HTTP reads remain thin adapters.

**Tech Stack:** TypeScript, Node test runner, node:child_process Git adapter, GitHub Actions, Vercel static configuration.

## Global Constraints

- The canonical snapshot is exactly forecast-log.jsonl, daily-skill.jsonl, and source-weights.json.
- Seed reliability-state before deleting generated data from main.
- Never force push, regress evidence, publish after fatal cycle failure, or expose secrets.
- Scoring Skip is successful and may publish newly logged forecasts.
- Runtime failure keeps cached last-good state, then Equal Fallback.
- Disable Vercel deployment for reliability-state.

---

### Task 1: Centralize the Reliability Snapshot manifest

**Files:**
- Modify: lib/reliability/persistence.ts
- Modify: lib/reliability/persistence.test.ts

**Interfaces:**
- Produces: RELIABILITY_STATE_FILES readonly tuple
- Produces: readReliabilitySnapshot and writeReliabilitySnapshot using only that manifest

- [ ] **Step 1: Write failing manifest tests**

Assert the exported manifest contains exactly the three canonical names, rejects an unrelated JSON file from publication input, and snapshot round-trip is byte/record coherent.

Run: node --test lib/reliability/persistence.test.ts

Expected: FAIL because the canonical manifest is private and unrelated-file rejection is absent.

- [ ] **Step 2: Implement and verify**

Export the readonly manifest, derive file paths and read/write loops from it, preserve strict weight parsing, and avoid filesystem globs.

Run: node --test lib/reliability/persistence.test.ts lib/reliability/stateSnapshot.test.ts

Expected: PASS.

- [ ] **Step 3: Commit**

~~~bash
git add lib/reliability/persistence.ts lib/reliability/persistence.test.ts
git commit -m "refactor: centralize reliability snapshot manifest"
~~~

### Task 2: Implement the versioned Git state target

**Files:**
- Create: lib/reliability/gitStateTarget.ts
- Create: lib/reliability/gitStateTarget.test.ts

**Interfaces:**
- Produces: GitStateTarget.read(ref?)
- Produces: GitStateTarget.publish({ expectedRevision, snapshot, message })

- [ ] **Step 1: Write local bare-repository tests**

Create temporary bare and working repositories with execFile git commands. Test missing branch, first publication, read-back, unchanged publication, second fast-forward publication, expected-revision conflict, and exact committed manifest.

Run: node --test lib/reliability/gitStateTarget.test.ts

Expected: FAIL because gitStateTarget.ts is absent.

- [ ] **Step 2: Implement the adapter**

Use promisify(execFile) from node:child_process and node:util through a small injected command runner. Fetch branch refs, materialize state through temporary worktrees, create normal commits, and push HEAD:reliability-state without force. Before publish, fetch and compare the observed revision.

- [ ] **Step 3: Verify**

Run: node --test lib/reliability/gitStateTarget.test.ts

Expected: PASS using only local repositories and temporary directories.

- [ ] **Step 4: Commit**

~~~bash
git add lib/reliability/gitStateTarget.ts lib/reliability/gitStateTarget.test.ts
git commit -m "feat: add git reliability state target"
~~~

### Task 3: Implement the deep publication transaction

**Files:**
- Create: lib/reliability/stateTransaction.ts
- Create: lib/reliability/stateTransaction.test.ts
- Modify: scripts/precip-reliability.ts
- Modify: scripts/reliability-state.ts
- Modify: package.json

**Interfaces:**
- Consumes: ReliabilityStateTarget and runReliabilityCycle
- Produces: runReliabilityStateTransaction(dependencies, request)
- Produces: one scheduled npm command accepting optional --recover

- [ ] **Step 1: Write failing transaction tests**

Use an in-memory target. Test successful publish, unchanged cycle, Scoring Skip with new forecasts, fatal-cycle no publication, malformed restored state, regression rejection, explicit recovery, and moved-tip conflict.

Run: node --test lib/reliability/stateTransaction.test.ts

Expected: FAIL because the transaction module is absent.

- [ ] **Step 2: Implement orchestration**

Read the target, merge optional recovery, materialize one temporary candidate directory, run the injected daily cycle against createFileReliabilityStore(candidateDir), reread candidate, assert monotonicity against a refreshed target tip, and publish by expected revision. Let any fatal error reject before publish.

- [ ] **Step 3: Make the CLI thin**

Construct production provider/observation dependencies and the Git target in scripts/precip-reliability.ts. Keep console reporting there. Reduce scripts/reliability-state.ts to explicit inspection/recovery utilities or route its transact command directly to the module. Add a package script whose name matches workflow and README.

- [ ] **Step 4: Verify**

Run: node --test lib/reliability/*.test.ts

Expected: PASS.

Run: npx tsc --noEmit

Expected: exit 0.

- [ ] **Step 5: Commit**

~~~bash
git add lib/reliability/stateTransaction.ts lib/reliability/stateTransaction.test.ts scripts/precip-reliability.ts scripts/reliability-state.ts package.json
git commit -m "refactor: publish reliability state transactionally"
~~~

### Task 4: Migrate automation and runtime storage

**Files:**
- Modify: .github/workflows/precip-reliability.yml
- Modify: lib/reliability/runtimeWeightsSource.ts
- Modify: lib/reliability/runtimeWeightsSource.test.ts
- Create: vercel.json
- Modify: .gitignore
- Remove from main after branch seed: data/reliability/forecast-log.jsonl
- Remove from main after branch seed: data/reliability/daily-skill.jsonl
- Remove from main after branch seed: data/reliability/source-weights.json

- [ ] **Step 1: Update failing runtime URL test**

Change the expected URL to raw.githubusercontent.com/mhju0/seoulsky/reliability-state/data/reliability/source-weights.json.

Run: node --test lib/reliability/runtimeWeightsSource.test.ts

Expected: FAIL while production still points to main.

- [ ] **Step 2: Update runtime and Vercel configuration**

Point the pinned reader to reliability-state. Add:

~~~json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "git": {
    "deploymentEnabled": {
      "reliability-state": false
    }
  }
}
~~~

- [ ] **Step 3: Replace workflow shell transaction**

Keep checkout, Node setup, permissions, schedule, concurrency, secrets, and recovery input. Replace repeated restore/recovery/persist shell blocks with the single transaction npm command. Publication runs only after that command succeeds; remove if: always() from state publication behavior.

- [ ] **Step 4: Seed the remote branch before cleanup**

Create a temporary worktree from the current state-bearing main revision. Add vercel.json and the canonical files, commit, and push HEAD:reliability-state as a normal new branch. Verify:

~~~bash
git ls-remote --heads origin reliability-state
git show origin/reliability-state:data/reliability/source-weights.json
~~~

Expected: branch exists and learned weights parse as the current checkpoint.

- [ ] **Step 5: Remove generated state from main**

Restore ignore rules for /data/reliability/*.json and *.jsonl, remove only the three tracked files from main, and leave the seeded branch untouched.

- [ ] **Step 6: Verify automation configuration**

Run: node --test lib/reliability/runtimeWeightsSource.test.ts lib/reliability/gitStateTarget.test.ts lib/reliability/stateTransaction.test.ts

Expected: PASS.

Run: npm run lint && npx tsc --noEmit

Expected: exit 0.

- [ ] **Step 7: Commit migration**

~~~bash
git add .github/workflows/precip-reliability.yml lib/reliability/runtimeWeightsSource.ts lib/reliability/runtimeWeightsSource.test.ts vercel.json .gitignore
git add -u data/reliability
git commit -m "chore: separate reliability state from releases"
~~~

### Task 5: Synchronize repository and GitHub metadata

**Files:**
- Modify: README.md
- Modify: lib/reliability/README.md
- Modify: docs/weather-sources.md
- Modify: .env.example
- Modify: CLAUDE.md

- [ ] **Step 1: Update every current description**

Document the transaction, dedicated branch, Vercel exclusion, canonical snapshot, safe recovery, runtime raw read, atomic Provider Snapshot, RadarDelivery, progressive radar warming, commands, and limits. Keep historical design records unchanged.

- [ ] **Step 2: Audit consistency**

Run: rg -n "tracked on main|main: data/reliability|single main branch|preload every frame|getProviderStatus|readForecast" README.md lib/reliability/README.md docs/weather-sources.md .env.example CLAUDE.md .github lib app components

Expected: no stale current-state claim.

- [ ] **Step 3: Run full verification**

Run: npm run lint

Expected: exit 0.

Run: npx tsc --noEmit

Expected: exit 0.

Run: npm test

Expected: all tests pass.

Run: npm run build

Expected: exit 0.

- [ ] **Step 4: Update GitHub metadata**

Run:

~~~bash
gh repo edit mhju0/seoulsky --description "Cinematic Seoul weather with KMA radar, graceful multi-provider fusion, and a precipitation ensemble that learns from verified KMA observations." --homepage "https://seoulsky.vercel.app/sky"
~~~

Verify with gh repo view --json description,homepageUrl.

- [ ] **Step 5: Commit synchronized documentation**

~~~bash
git add README.md lib/reliability/README.md docs/weather-sources.md .env.example
git add -f CLAUDE.md
git commit -m "docs: synchronize SeoulSky architecture"
~~~
