import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReliabilityCycleStore } from "./cycle.ts";
import {
  weightsStateRegressions,
  type ReliabilitySnapshot,
} from "./stateSnapshot.ts";
import type { DailySkillRecord, ForecastRecord, WeightsState } from "./types.ts";
import { parseWeightsState } from "./weightsState.ts";

/** The complete, canonical file set that may comprise a Reliability Snapshot. */
export const RELIABILITY_STATE_FILES = [
  "forecast-log.jsonl",
  "daily-skill.jsonl",
  "source-weights.json",
] as const;

export type ReliabilityStateFile = (typeof RELIABILITY_STATE_FILES)[number];

const [FORECAST_LOG, DAILY_SKILL, WEIGHTS_FILE] = RELIABILITY_STATE_FILES;

type DatedSourceRecord = { date: string; source: string };

/** Output directory for the batch/local filesystem adapter. */
export function reliabilityDataDir(): string {
  return process.env.RELIABILITY_DATA_DIR?.trim() || path.join(process.cwd(), "data", "reliability");
}

function filePath(dataDir: string, file: ReliabilityStateFile): string {
  return path.join(dataDir, file);
}

/** Reject a publication file list that is not the exact canonical manifest. */
export function assertReliabilityStateFiles(
  files: readonly string[],
): asserts files is readonly ReliabilityStateFile[] {
  if (
    files.length !== RELIABILITY_STATE_FILES.length ||
    files.some((file, index) => file !== RELIABILITY_STATE_FILES[index])
  ) {
    throw new Error(`Unexpected reliability state file: ${files.join(", ")}`);
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readJsonl<T>(dataDir: string, file: ReliabilityStateFile): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(filePath(dataDir, file), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

async function appendJsonl(
  dataDir: string,
  file: ReliabilityStateFile,
  rows: readonly object[],
): Promise<void> {
  if (rows.length === 0) return;
  await mkdir(dataDir, { recursive: true });
  await appendFile(filePath(dataDir, file), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

async function appendUniqueJsonl<T extends DatedSourceRecord>(
  dataDir: string,
  file: ReliabilityStateFile,
  records: readonly T[],
): Promise<number> {
  const existing = await readJsonl<T>(dataDir, file);
  const seen = new Set(existing.map((record) => `${record.date}|${record.source}`));
  const fresh: T[] = [];
  for (const record of records) {
    const key = `${record.date}|${record.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(record);
  }
  await appendJsonl(dataDir, file, fresh);
  return fresh.length;
}

async function readWeightsAt(dataDir: string, rejectInvalid = false): Promise<WeightsState | null> {
  let text: string;
  try {
    text = await readFile(filePath(dataDir, WEIGHTS_FILE), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }

  try {
    const state = parseWeightsState(JSON.parse(text));
    if (state) return state;
  } catch {
    // Rejected below for batch/recovery callers; lenient readers return null.
  }
  if (rejectInvalid) throw new Error("Existing invalid reliability weight state; refusing a cold restart");
  return null;
}

async function writeWeightsAt(dataDir: string, state: WeightsState): Promise<void> {
  const parsed = parseWeightsState(state);
  if (!parsed) throw new Error("Refusing to persist invalid reliability weight state");

  const prior = await readWeightsAt(dataDir, true);
  const regressions = weightsStateRegressions(prior, parsed);
  if (regressions.length > 0) {
    throw new Error(`Refusing to regress reliability weight state: ${regressions.join("; ")}`);
  }

  await mkdir(dataDir, { recursive: true });
  const target = filePath(dataDir, WEIGHTS_FILE);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  await rename(temporary, target);
}

/** Node filesystem adapter used only by the batch, recovery tooling, and tests. */
export function createFileReliabilityStore(dataDir: string): ReliabilityCycleStore {
  return {
    appendForecasts(records) {
      return appendUniqueJsonl(dataDir, FORECAST_LOG, records);
    },
    async readForecasts(date) {
      return (await readJsonl<ForecastRecord>(dataDir, FORECAST_LOG)).filter((record) => record.date === date);
    },
    appendDailySkill(records) {
      return appendUniqueJsonl(dataDir, DAILY_SKILL, records);
    },
    readDailySkill() {
      return readJsonl<DailySkillRecord>(dataDir, DAILY_SKILL);
    },
    readWeights() {
      return readWeightsAt(dataDir, true);
    },
    writeWeights(state) {
      return writeWeightsAt(dataDir, state);
    },
  };
}

/** Read all three durable files for recovery and pre-push monotonic checks. */
export async function readReliabilitySnapshot(dataDir: string): Promise<ReliabilitySnapshot> {
  const snapshot: ReliabilitySnapshot = { forecasts: [], dailySkill: [], weights: null };
  for (const file of RELIABILITY_STATE_FILES) {
    switch (file) {
      case FORECAST_LOG:
        snapshot.forecasts = await readJsonl<ForecastRecord>(dataDir, file);
        break;
      case DAILY_SKILL:
        snapshot.dailySkill = await readJsonl<DailySkillRecord>(dataDir, file);
        break;
      case WEIGHTS_FILE:
        snapshot.weights = await readWeightsAt(dataDir, true);
        break;
    }
  }
  return snapshot;
}

/** Replace a recovery workspace with an already-validated/merged snapshot. */
export async function writeReliabilitySnapshot(
  dataDir: string,
  snapshot: ReliabilitySnapshot,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const jsonl = (records: readonly object[]) =>
    records.length === 0 ? "" : records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  for (const file of RELIABILITY_STATE_FILES) {
    switch (file) {
      case FORECAST_LOG:
        await writeFile(filePath(dataDir, file), jsonl(snapshot.forecasts), "utf8");
        break;
      case DAILY_SKILL:
        await writeFile(filePath(dataDir, file), jsonl(snapshot.dailySkill), "utf8");
        break;
      case WEIGHTS_FILE:
        if (snapshot.weights) {
          const parsed = parseWeightsState(snapshot.weights);
          if (!parsed) throw new Error("Refusing to write invalid reliability weight state");
          await writeFile(filePath(dataDir, file), JSON.stringify(parsed, null, 2) + "\n", "utf8");
        } else {
          await unlink(filePath(dataDir, file)).catch((error: unknown) => {
            if (!isMissingFile(error)) throw error;
          });
        }
        break;
    }
  }
}

function defaultStore(): ReliabilityCycleStore {
  return createFileReliabilityStore(reliabilityDataDir());
}

// Backwards-compatible batch/local convenience functions. The web runtime does
// not import this module; runtimeWeightsSource uses the durable HTTP seam.
export function appendForecasts(records: readonly ForecastRecord[]): Promise<number> {
  return defaultStore().appendForecasts(records);
}

export function readForecasts(date: string): Promise<ForecastRecord[]> {
  return defaultStore().readForecasts(date);
}

export function readDailySkill(): Promise<DailySkillRecord[]> {
  return defaultStore().readDailySkill();
}

export function appendDailySkill(records: readonly DailySkillRecord[]): Promise<number> {
  return defaultStore().appendDailySkill(records);
}

export function readWeights(): Promise<WeightsState | null> {
  return defaultStore().readWeights();
}

export function writeWeights(state: WeightsState): Promise<void> {
  return defaultStore().writeWeights(state);
}
