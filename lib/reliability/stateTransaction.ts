import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ReliabilityCycleDependencies,
  ReliabilityCycleResult,
} from "./cycle.ts";
import {
  createFileReliabilityStore,
  readReliabilitySnapshot,
  writeReliabilitySnapshot,
} from "./persistence.ts";
import {
  assertReliabilitySnapshotMonotonic,
  mergeReliabilitySnapshots,
  type ReliabilitySnapshot,
} from "./stateSnapshot.ts";
import type { DailySkillRecord, ForecastRecord } from "./types.ts";
import {
  isExplicitOffsetIsoInstant,
  parseWeightsState,
} from "./weightsState.ts";

const CANDIDATE_PREFIX = "seoulsky-reliability-candidate-";
const PROVIDER_IDS = new Set([
  "open-meteo",
  "met-norway",
  "kma",
  "pirate-weather",
  "weather-api",
  "open-meteo-air-quality",
  "airkorea",
  "rainviewer",
]);
const OUTCOMES = new Set(["hit", "miss", "false_alarm", "correct_dry"]);

export interface VersionedReliabilityState {
  revision: string;
  snapshot: ReliabilitySnapshot;
}

export interface ReliabilityStatePublicationRequest {
  expectedRevision: string | null;
  message: string;
  snapshot: ReliabilitySnapshot;
}

export interface ReliabilityStatePublicationResult {
  changed: boolean;
  revision: string;
}

/** Versioned persistence seam; Git is one adapter and tests use an in-memory target. */
export interface ReliabilityStateTarget {
  read(ref?: string): Promise<VersionedReliabilityState | null>;
  publish(
    request: ReliabilityStatePublicationRequest,
  ): Promise<ReliabilityStatePublicationResult>;
}

export type ReliabilityCycleRunner = (
  dependencies: ReliabilityCycleDependencies,
) => Promise<ReliabilityCycleResult>;

export interface ReliabilityStateTransactionDependencies
  extends Omit<ReliabilityCycleDependencies, "store"> {
  runCycle: ReliabilityCycleRunner;
  target: ReliabilityStateTarget;
  /** Injectable parent for candidate-isolation tests; production uses the OS temp directory. */
  temporaryDirectory?: string;
}

export interface ReliabilityStateTransactionRequest {
  recoveryRef?: string;
}

export interface ReliabilityStateTransactionResult {
  cycle: ReliabilityCycleResult;
  outcome: "published" | "unchanged";
  revision: string;
}

function emptySnapshot(): ReliabilitySnapshot {
  return { forecasts: [], dailySkill: [], weights: null };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isNumberBetween(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isNullableNumberBetween(value: unknown, minimum: number, maximum: number): boolean {
  return value === null || isNumberBetween(value, minimum, maximum);
}

function isForecastRecord(value: unknown): value is ForecastRecord {
  if (!isObject(value)) return false;
  return (
    hasExactKeys(value, ["date", "source", "region", "pop", "predicted_mm", "loggedAt"]) &&
    isCalendarDate(value.date) &&
    typeof value.source === "string" &&
    PROVIDER_IDS.has(value.source) &&
    value.region === "seoul" &&
    isNullableNumberBetween(value.pop, 0, 100) &&
    isNullableNumberBetween(value.predicted_mm, 0, Number.MAX_VALUE) &&
    isExplicitOffsetIsoInstant(value.loggedAt)
  );
}

function isContingency(value: unknown): boolean {
  if (!isObject(value)) return false;
  const keys = ["hits", "misses", "false_alarms", "correct_negatives"];
  return (
    hasExactKeys(value, keys) &&
    keys.every((key) => value[key] === 0 || value[key] === 1) &&
    keys.reduce((total, key) => total + Number(value[key]), 0) === 1
  );
}

function isDailySkillRecord(value: unknown): value is DailySkillRecord {
  if (!isObject(value)) return false;
  return (
    hasExactKeys(value, [
      "date",
      "source",
      "region",
      "pop",
      "predicted_mm",
      "observed_mm",
      "predicted_rain",
      "observed_rain",
      "outcome",
      "contingency",
      "csi",
      "categorical_skill",
      "quantitative_skill",
      "mae",
      "skill",
      "scoredAt",
    ]) &&
    isCalendarDate(value.date) &&
    typeof value.source === "string" &&
    PROVIDER_IDS.has(value.source) &&
    value.region === "seoul" &&
    isNullableNumberBetween(value.pop, 0, 100) &&
    isNullableNumberBetween(value.predicted_mm, 0, Number.MAX_VALUE) &&
    isNumberBetween(value.observed_mm, 0, Number.MAX_VALUE) &&
    typeof value.predicted_rain === "boolean" &&
    typeof value.observed_rain === "boolean" &&
    typeof value.outcome === "string" &&
    OUTCOMES.has(value.outcome) &&
    isContingency(value.contingency) &&
    isNullableNumberBetween(value.csi, 0, 1) &&
    isNumberBetween(value.categorical_skill, 0, 1) &&
    isNullableNumberBetween(value.quantitative_skill, 0, 1) &&
    isNullableNumberBetween(value.mae, 0, Number.MAX_VALUE) &&
    isNumberBetween(value.skill, 0, 1) &&
    isExplicitOffsetIsoInstant(value.scoredAt)
  );
}

function assertUniqueRecordKeys(
  records: readonly { date: string; source: string }[],
  label: string,
): void {
  const keys = records.map((record) => `${record.date}|${record.source}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error(`Invalid reliability ${label} records: duplicate date/source key`);
  }
}

function assertReliabilitySnapshotSchema(snapshot: ReliabilitySnapshot): void {
  if (!Array.isArray(snapshot.forecasts) || !snapshot.forecasts.every(isForecastRecord)) {
    throw new Error("Invalid reliability forecast record");
  }
  if (!Array.isArray(snapshot.dailySkill) || !snapshot.dailySkill.every(isDailySkillRecord)) {
    throw new Error("Invalid reliability daily-skill record");
  }
  if (snapshot.weights !== null && !parseWeightsState(snapshot.weights)) {
    throw new Error("Invalid reliability weight state");
  }
  assertUniqueRecordKeys(snapshot.forecasts, "forecast");
  assertUniqueRecordKeys(snapshot.dailySkill, "daily-skill");
}

async function materializeCandidate(
  dependencies: ReliabilityStateTransactionDependencies,
  snapshot: ReliabilitySnapshot,
): Promise<{ cycle: ReliabilityCycleResult; snapshot: ReliabilitySnapshot }> {
  const temporaryDirectory = path.resolve(dependencies.temporaryDirectory ?? tmpdir());
  await mkdir(temporaryDirectory, { recursive: true });
  const candidateDirectory = await mkdtemp(path.join(temporaryDirectory, CANDIDATE_PREFIX));

  try {
    await writeReliabilitySnapshot(candidateDirectory, snapshot);
    const cycle = await dependencies.runCycle({
      now: dependencies.now,
      sourceIds: dependencies.sourceIds,
      store: createFileReliabilityStore(candidateDirectory),
      collectForecasts: dependencies.collectForecasts,
      fetchObservation: dependencies.fetchObservation,
      ...(dependencies.eta === undefined ? {} : { eta: dependencies.eta }),
    });
    const candidate = await readReliabilitySnapshot(candidateDirectory);
    assertReliabilitySnapshotSchema(candidate);
    return { cycle, snapshot: candidate };
  } finally {
    await rm(candidateDirectory, { recursive: true, force: true });
  }
}

/**
 * Restore, optionally recover, run, validate, and publish one Reliability
 * Snapshot. All mutable cycle work stays isolated until the target's exact CAS.
 */
export async function runReliabilityStateTransaction(
  dependencies: ReliabilityStateTransactionDependencies,
  request: ReliabilityStateTransactionRequest = {},
): Promise<ReliabilityStateTransactionResult> {
  const current = await dependencies.target.read();
  let restored = current?.snapshot ?? emptySnapshot();

  if (request.recoveryRef !== undefined) {
    if (!request.recoveryRef.trim()) throw new Error("Reliability recovery ref is required");
    const recovery = await dependencies.target.read(request.recoveryRef);
    if (!recovery) {
      throw new Error(`Reliability recovery ref did not resolve: ${request.recoveryRef}`);
    }
    restored = mergeReliabilitySnapshots(recovery.snapshot, restored);
    assertReliabilitySnapshotMonotonic(current?.snapshot ?? emptySnapshot(), restored, {
      allowContentRepair: true,
    });
  }

  assertReliabilitySnapshotSchema(restored);

  const candidate = await materializeCandidate(dependencies, restored);
  const refreshed = await dependencies.target.read();
  if (refreshed) assertReliabilitySnapshotSchema(refreshed.snapshot);
  assertReliabilitySnapshotMonotonic(
    refreshed?.snapshot ?? emptySnapshot(),
    candidate.snapshot,
    { allowContentRepair: request.recoveryRef !== undefined },
  );

  const publication = await dependencies.target.publish({
    expectedRevision: refreshed?.revision ?? null,
    message: `chore(reliability): persist learning state ${candidate.cycle.runAt}`,
    snapshot: candidate.snapshot,
  });

  return {
    cycle: candidate.cycle,
    outcome: publication.changed ? "published" : "unchanged",
    revision: publication.revision,
  };
}
