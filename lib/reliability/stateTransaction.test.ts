import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runReliabilityCycle } from "./cycle.ts";
import { GitStateConflictError } from "./gitStateTarget.ts";
import type { ReliabilitySnapshot } from "./stateSnapshot.ts";
import {
  runReliabilityStateTransaction,
  type ReliabilityStatePublicationRequest,
  type ReliabilityStateTarget,
  type VersionedReliabilityState,
} from "./stateTransaction.ts";
import type { DailySkillRecord, ForecastRecord, WeightsState } from "./types.ts";

const RUN_AT = new Date("2026-07-14T00:00:00.000Z");

function forecast(
  date: string,
  source: ForecastRecord["source"] = "open-meteo",
  pop = 80,
): ForecastRecord {
  return {
    date,
    source,
    region: "seoul",
    pop,
    predicted_mm: pop > 0 ? 4 : 0,
    loggedAt: `${date}T00:00:00.000Z`,
  };
}

function dailySkill(overrides: Partial<DailySkillRecord> = {}): DailySkillRecord {
  return {
    date: "2026-07-12",
    source: "open-meteo",
    region: "seoul",
    pop: 80,
    predicted_mm: 4,
    observed_mm: 6,
    predicted_rain: true,
    observed_rain: true,
    outcome: "hit",
    contingency: { hits: 1, misses: 0, false_alarms: 0, correct_negatives: 0 },
    csi: 1,
    categorical_skill: 1,
    quantitative_skill: 0.9,
    mae: 2,
    skill: 0.95,
    scoredAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

function weights(overrides: Partial<WeightsState> = {}): WeightsState {
  return {
    updatedAt: "2026-07-12T00:00:00.000Z",
    eventsScored: 0,
    processedDates: [],
    weights: { "open-meteo": 0.5, kma: 0.5 },
    ...overrides,
  };
}

function snapshot(overrides: Partial<ReliabilitySnapshot> = {}): ReliabilitySnapshot {
  return {
    forecasts: [forecast("2026-07-13")],
    dailySkill: [],
    weights: weights(),
    ...overrides,
  };
}

function cloneSnapshot(value: ReliabilitySnapshot): ReliabilitySnapshot {
  return structuredClone(value);
}

class MemoryReliabilityStateTarget implements ReliabilityStateTarget {
  current: VersionedReliabilityState | null;
  readonly recoveries = new Map<string, VersionedReliabilityState>();
  readonly publicationRequests: ReliabilityStatePublicationRequest[] = [];
  currentReads = 0;
  onCurrentRead?: (read: number, target: MemoryReliabilityStateTarget) => void;
  beforePublish?: (target: MemoryReliabilityStateTarget) => void;
  private nextRevision = 2;

  constructor(current: VersionedReliabilityState | null) {
    this.current = current
      ? { revision: current.revision, snapshot: cloneSnapshot(current.snapshot) }
      : null;
  }

  async read(ref?: string): Promise<VersionedReliabilityState | null> {
    if (ref !== undefined) {
      const recovered = this.recoveries.get(ref);
      if (!recovered) throw new Error(`Unknown recovery ref: ${ref}`);
      return { revision: recovered.revision, snapshot: cloneSnapshot(recovered.snapshot) };
    }

    this.currentReads += 1;
    this.onCurrentRead?.(this.currentReads, this);
    return this.current
      ? { revision: this.current.revision, snapshot: cloneSnapshot(this.current.snapshot) }
      : null;
  }

  async publish(request: ReliabilityStatePublicationRequest) {
    this.publicationRequests.push({
      ...request,
      snapshot: cloneSnapshot(request.snapshot),
    });
    this.beforePublish?.(this);

    const observedRevision = this.current?.revision ?? null;
    if (observedRevision !== request.expectedRevision) {
      throw new GitStateConflictError(request.expectedRevision, observedRevision);
    }

    const changed =
      this.current === null ||
      JSON.stringify(this.current.snapshot) !== JSON.stringify(request.snapshot);
    if (!changed && this.current) return { changed: false, revision: this.current.revision };

    const revision = `revision-${this.nextRevision++}`;
    this.current = { revision, snapshot: cloneSnapshot(request.snapshot) };
    return { changed: true, revision };
  }
}

async function withCandidateParent(
  run: (candidateParent: string) => Promise<void>,
): Promise<void> {
  const candidateParent = await mkdtemp(path.join(tmpdir(), "raintoday-state-transaction-test-"));
  try {
    await run(candidateParent);
  } finally {
    await rm(candidateParent, { recursive: true, force: true });
  }
}

function dependencies(
  target: ReliabilityStateTarget,
  candidateParent: string,
  overrides: Partial<Parameters<typeof runReliabilityStateTransaction>[0]> = {},
): Parameters<typeof runReliabilityStateTransaction>[0] {
  return {
    target,
    runCycle: runReliabilityCycle,
    now: () => new Date(RUN_AT),
    sourceIds: ["open-meteo", "kma"],
    collectForecasts: async (date, now) => [
      {
        ...forecast(date),
        loggedAt: now.toISOString(),
      },
    ],
    fetchObservation: async (date) => ({
      date,
      region: "seoul",
      observed_mm: 6,
      source: "kma-asos-observation",
      observedAt: RUN_AT.toISOString(),
    }),
    temporaryDirectory: candidateParent,
    ...overrides,
  };
}

test("a successful transaction runs through isolated file persistence and publishes by refreshed revision", async () => {
  await withCandidateParent(async (candidateParent) => {
    const target = new MemoryReliabilityStateTarget({
      revision: "revision-1",
      snapshot: snapshot(),
    });
    let observedCandidateDirectories = 0;

    const result = await runReliabilityStateTransaction(
      dependencies(target, candidateParent, {
        runCycle: async (cycleDependencies) => {
          const entries = await readdir(candidateParent, { withFileTypes: true });
          observedCandidateDirectories = entries.filter((entry) => entry.isDirectory()).length;
          return runReliabilityCycle(cycleDependencies);
        },
      }),
    );

    assert.equal(observedCandidateDirectories, 1);
    assert.equal(result.cycle.forecast.appended, 1);
    assert.equal(result.cycle.scoring.appended, 1);
    assert.equal(result.outcome, "published");
    assert.equal(result.revision, "revision-2");
    assert.equal(target.publicationRequests.length, 1);
    assert.equal(target.publicationRequests[0]?.expectedRevision, "revision-1");
    assert.equal(
      target.publicationRequests[0]?.message,
      "chore(reliability): persist learning state 2026-07-14T00:00:00.000Z",
    );
    assert.deepEqual(
      target.current?.snapshot.forecasts.map(({ date, source }) => ({ date, source })),
      [
        { date: "2026-07-13", source: "open-meteo" },
        { date: "2026-07-15", source: "open-meteo" },
      ],
    );
    assert.equal(target.current?.snapshot.dailySkill.length, 1);
    assert.equal(target.current?.snapshot.weights?.eventsScored, 1);
    assert.deepEqual(await readdir(candidateParent), [], "the isolated candidate is always removed");
  });
});

test("an unchanged cycle delegates the no-op publication through the target CAS seam", async () => {
  await withCandidateParent(async (candidateParent) => {
    const initial = snapshot({
      forecasts: [forecast("2026-07-13"), forecast("2026-07-15")],
    });
    const target = new MemoryReliabilityStateTarget({
      revision: "revision-1",
      snapshot: initial,
    });

    const result = await runReliabilityStateTransaction(
      dependencies(target, candidateParent, {
        collectForecasts: async () => [forecast("2026-07-15")],
        fetchObservation: async () => null,
      }),
    );

    assert.equal(result.cycle.forecast.appended, 0);
    assert.equal(result.cycle.weighting.written, false);
    assert.deepEqual(target.publicationRequests[0]?.snapshot, initial);
    assert.equal(result.outcome, "unchanged");
    assert.equal(result.revision, "revision-1");
    assert.equal(target.currentReads, 2, "the target tip is refreshed before the no-op CAS");
  });
});

test("a Scoring Skip still publishes newly collected forecasts", async () => {
  await withCandidateParent(async (candidateParent) => {
    const initial = snapshot();
    const target = new MemoryReliabilityStateTarget({
      revision: "revision-1",
      snapshot: initial,
    });

    const result = await runReliabilityStateTransaction(
      dependencies(target, candidateParent, { fetchObservation: async () => null }),
    );

    assert.equal(result.cycle.scoring.observation, null);
    assert.equal(result.cycle.forecast.appended, 1);
    assert.equal(result.outcome, "published");
    assert.equal(target.current?.snapshot.forecasts.length, 2);
    assert.deepEqual(target.current?.snapshot.dailySkill, []);
    assert.deepEqual(target.current?.snapshot.weights, initial.weights);
  });
});

test("a fatal cycle rejects after candidate writes without publishing partial state", async () => {
  await withCandidateParent(async (candidateParent) => {
    const initial = snapshot();
    const target = new MemoryReliabilityStateTarget({
      revision: "revision-1",
      snapshot: initial,
    });

    await assert.rejects(
      () =>
        runReliabilityStateTransaction(
          dependencies(target, candidateParent, {
            runCycle: async (cycleDependencies) => {
              await cycleDependencies.store.appendForecasts([forecast("2026-07-15")]);
              throw new Error("fatal observation transport failure");
            },
          }),
        ),
      /fatal observation transport failure/,
    );

    assert.equal(target.publicationRequests.length, 0);
    assert.deepEqual(target.current?.snapshot, initial);
    assert.deepEqual(await readdir(candidateParent), [], "failed candidates are removed");
  });
});

test("malformed restored weight state fails closed before the cycle or publication", async () => {
  await withCandidateParent(async (candidateParent) => {
    const malformed = snapshot({
      weights: {
        updatedAt: "not-an-instant",
        eventsScored: -1,
        processedDates: [],
        weights: { "open-meteo": 2 },
      } as WeightsState,
    });
    const target = new MemoryReliabilityStateTarget({
      revision: "revision-1",
      snapshot: malformed,
    });
    let cycleStarted = false;

    await assert.rejects(
      () =>
        runReliabilityStateTransaction(
          dependencies(target, candidateParent, {
            runCycle: async (cycleDependencies) => {
              cycleStarted = true;
              return runReliabilityCycle(cycleDependencies);
            },
          }),
        ),
      /invalid reliability weight state/i,
    );

    assert.equal(cycleStarted, false);
    assert.equal(target.publicationRequests.length, 0);
    assert.deepEqual(await readdir(candidateParent), []);
  });
});

test("malformed restored forecast and skill rows fail schema validation before the cycle", async () => {
  const malformedSnapshots: Array<{ label: string; snapshot: ReliabilitySnapshot }> = [
    {
      label: "forecast",
      snapshot: snapshot({
        forecasts: [{ date: "not-a-date", source: "open-meteo" } as ForecastRecord],
      }),
    },
    {
      label: "daily-skill",
      snapshot: snapshot({
        dailySkill: [{ date: "2026-07-12", source: "open-meteo" } as DailySkillRecord],
      }),
    },
    {
      label: "forecast",
      snapshot: snapshot({
        forecasts: [
          { ...forecast("2026-07-13"), loggedAt: "2026-07-13T00:00:00.000" },
        ],
      }),
    },
    {
      label: "daily-skill",
      snapshot: snapshot({
        dailySkill: [dailySkill({ scoredAt: "2026-02-30T00:00:00.000Z" })],
      }),
    },
  ];

  for (const malformed of malformedSnapshots) {
    await withCandidateParent(async (candidateParent) => {
      const target = new MemoryReliabilityStateTarget({
        revision: "revision-1",
        snapshot: malformed.snapshot,
      });
      let cycleStarted = false;

      await assert.rejects(
        () =>
          runReliabilityStateTransaction(
            dependencies(target, candidateParent, {
              runCycle: async (cycleDependencies) => {
                cycleStarted = true;
                return runReliabilityCycle(cycleDependencies);
              },
            }),
          ),
        new RegExp(`invalid reliability ${malformed.label} record`, "i"),
      );

      assert.equal(cycleStarted, false);
      assert.equal(target.publicationRequests.length, 0);
      assert.deepEqual(await readdir(candidateParent), []);
    });
  }
});

test("a malformed refreshed target snapshot is rejected before monotonic comparison or publication", async () => {
  await withCandidateParent(async (candidateParent) => {
    const target = new MemoryReliabilityStateTarget({
      revision: "revision-1",
      snapshot: snapshot({ forecasts: [forecast("2026-07-13"), forecast("2026-07-15")] }),
    });
    target.onCurrentRead = (read, memoryTarget) => {
      if (read !== 2) return;
      memoryTarget.current = {
        revision: "revision-malformed",
        snapshot: snapshot({
          forecasts: [{ date: "not-a-date", source: "open-meteo" } as ForecastRecord],
        }),
      };
    };

    await assert.rejects(
      () =>
        runReliabilityStateTransaction(
          dependencies(target, candidateParent, {
            collectForecasts: async () => [forecast("2026-07-15")],
            fetchObservation: async () => null,
          }),
        ),
      /invalid reliability forecast record/i,
    );

    assert.equal(target.currentReads, 2);
    assert.equal(target.publicationRequests.length, 0);
  });
});

test("a candidate that loses state from the refreshed target tip is rejected before publication", async () => {
  await withCandidateParent(async (candidateParent) => {
    const target = new MemoryReliabilityStateTarget({
      revision: "revision-1",
      snapshot: snapshot({ forecasts: [forecast("2026-07-13"), forecast("2026-07-15")] }),
    });
    target.onCurrentRead = (read, memoryTarget) => {
      if (read !== 2 || !memoryTarget.current) return;
      memoryTarget.current = {
        revision: "revision-competitor",
        snapshot: snapshot({
          forecasts: [
            forecast("2026-07-13"),
            forecast("2026-07-15"),
            forecast("2026-07-16", "kma"),
          ],
        }),
      };
    };

    await assert.rejects(
      () =>
        runReliabilityStateTransaction(
          dependencies(target, candidateParent, {
            collectForecasts: async () => [forecast("2026-07-15")],
            fetchObservation: async () => null,
          }),
        ),
      /reliability state regression.*lost/i,
    );

    assert.equal(target.publicationRequests.length, 0);
    assert.equal(target.current?.revision, "revision-competitor");
  });
});

test("an explicit recovery unions history, prefers repaired rows, and restores stronger weights", async () => {
  await withCandidateParent(async (candidateParent) => {
    const current = snapshot({
      forecasts: [forecast("2026-07-13", "open-meteo", 5), forecast("2026-07-15")],
      weights: weights({ updatedAt: "2026-07-13T00:00:00.000Z" }),
    });
    const knownGood = snapshot({
      forecasts: [forecast("2026-07-13", "open-meteo", 90), forecast("2026-07-12", "kma")],
      weights: weights({
        updatedAt: "2026-07-10T00:00:00.000Z",
        eventsScored: 1,
        processedDates: ["2026-07-09"],
        weights: { "open-meteo": 0.55, kma: 0.45 },
      }),
    });
    const target = new MemoryReliabilityStateTarget({
      revision: "revision-1",
      snapshot: current,
    });
    target.recoveries.set("refs/tags/known-good", {
      revision: "revision-recovery",
      snapshot: knownGood,
    });

    const result = await runReliabilityStateTransaction(
      dependencies(target, candidateParent, {
        collectForecasts: async () => [forecast("2026-07-15")],
        fetchObservation: async () => null,
      }),
      { recoveryRef: "refs/tags/known-good" },
    );

    assert.equal(result.outcome, "published");
    assert.deepEqual(
      target.current?.snapshot.forecasts.map(({ date, source, pop }) => ({ date, source, pop })),
      [
        { date: "2026-07-12", source: "kma", pop: 80 },
        { date: "2026-07-13", source: "open-meteo", pop: 90 },
        { date: "2026-07-15", source: "open-meteo", pop: 80 },
      ],
    );
    assert.deepEqual(target.current?.snapshot.weights, knownGood.weights);
    assert.equal(target.publicationRequests[0]?.expectedRevision, "revision-1");
  });
});

test("a target move after refresh propagates the exact revision conflict and preserves the winner", async () => {
  await withCandidateParent(async (candidateParent) => {
    const target = new MemoryReliabilityStateTarget({
      revision: "revision-1",
      snapshot: snapshot(),
    });
    const competitor = snapshot({
      forecasts: [forecast("2026-07-13"), forecast("2026-07-16", "kma")],
    });
    target.beforePublish = (memoryTarget) => {
      memoryTarget.current = {
        revision: "revision-competitor",
        snapshot: cloneSnapshot(competitor),
      };
    };

    await assert.rejects(
      () =>
        runReliabilityStateTransaction(dependencies(target, candidateParent)),
      (error: unknown) => {
        assert.ok(error instanceof GitStateConflictError);
        assert.equal(error.expectedRevision, "revision-1");
        assert.equal(error.observedRevision, "revision-competitor");
        return true;
      },
    );

    assert.equal(target.publicationRequests.length, 1);
    assert.deepEqual(target.current?.snapshot, competitor);
    assert.deepEqual(await readdir(candidateParent), []);
  });
});
