import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendForecasts,
  assertReliabilityStateFiles,
  createFileReliabilityStore,
  readForecasts,
  readReliabilitySnapshot,
  RELIABILITY_STATE_FILES,
  writeReliabilitySnapshot,
} from "./persistence.ts";

test("reliability publication manifest names exactly the durable snapshot files", () => {
  assert.deepEqual(RELIABILITY_STATE_FILES, [
    "forecast-log.jsonl",
    "daily-skill.jsonl",
    "source-weights.json",
  ]);
});

test("reliability publication rejects files outside its canonical manifest", () => {
  assert.throws(
    () => assertReliabilityStateFiles([...RELIABILITY_STATE_FILES, "unrelated.json"]),
    /unexpected reliability state file/i,
  );
});

test("reliability publication rejects a missing canonical file", () => {
  assert.throws(
    () => assertReliabilityStateFiles(RELIABILITY_STATE_FILES.slice(0, -1)),
    /unexpected reliability state file/i,
  );
});

test("reliability publication rejects reordered canonical files", () => {
  assert.throws(
    () =>
      assertReliabilityStateFiles([
        RELIABILITY_STATE_FILES[1],
        RELIABILITY_STATE_FILES[0],
        RELIABILITY_STATE_FILES[2],
      ]),
    /unexpected reliability state file/i,
  );
});

test("reliability snapshot round-trips canonical bytes and records", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "raintoday-reliability-"));
  const snapshot = {
    forecasts: [
      {
        date: "2026-07-15",
        source: "open-meteo" as const,
        region: "seoul",
        pop: 30,
        predicted_mm: 1.2,
        loggedAt: "2026-07-14T00:00:00.000Z",
      },
    ],
    dailySkill: [
      {
        date: "2026-07-14",
        source: "kma" as const,
        region: "seoul",
        pop: 70,
        predicted_mm: 3.1,
        observed_mm: 4,
        predicted_rain: true,
        observed_rain: true,
        outcome: "hit" as const,
        contingency: { hits: 1, misses: 0, false_alarms: 0, correct_negatives: 0 },
        csi: 1,
        categorical_skill: 1,
        quantitative_skill: 0.95,
        mae: 0.9,
        skill: 0.98,
        scoredAt: "2026-07-15T00:00:00.000Z",
      },
    ],
    weights: {
      updatedAt: "2026-07-15T00:00:00.000Z",
      eventsScored: 1,
      processedDates: ["2026-07-14"],
      weights: { "open-meteo": 0.6, kma: 0.4 },
    },
  };

  try {
    await writeReliabilitySnapshot(dir, snapshot);

    assert.equal(
      readFileSync(path.join(dir, "forecast-log.jsonl"), "utf8"),
      `${JSON.stringify(snapshot.forecasts[0])}\n`,
    );
    assert.equal(
      readFileSync(path.join(dir, "daily-skill.jsonl"), "utf8"),
      `${JSON.stringify(snapshot.dailySkill[0])}\n`,
    );
    assert.equal(
      readFileSync(path.join(dir, "source-weights.json"), "utf8"),
      `${JSON.stringify(snapshot.weights, null, 2)}\n`,
    );
    assert.deepEqual(await readReliabilitySnapshot(dir), snapshot);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reliability persistence keeps forecast writes idempotent", async () => {
  const previous = process.env.RELIABILITY_DATA_DIR;
  const dir = mkdtempSync(path.join(tmpdir(), "raintoday-reliability-"));
  process.env.RELIABILITY_DATA_DIR = dir;
  const record = {
    date: "2026-07-15",
    source: "open-meteo" as const,
    region: "seoul",
    pop: 30,
    predicted_mm: 1.2,
    loggedAt: "2026-07-14T00:00:00.000Z",
  };
  try {
    assert.equal(await appendForecasts([record]), 1);
    assert.equal(await appendForecasts([record]), 0);
    assert.deepEqual(await readForecasts(record.date), [record]);
  } finally {
    process.env.RELIABILITY_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file persistence refuses to replace learned weights with an older checkpoint", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "raintoday-reliability-"));
  const store = createFileReliabilityStore(dir);
  const current = {
    updatedAt: "2026-07-10T00:00:00.000Z",
    eventsScored: 51,
    processedDates: ["2026-07-09", "2026-07-10"],
    weights: { "open-meteo": 0.6, kma: 0.4 },
  };
  const regressed = {
    updatedAt: "2026-06-25T00:00:00.000Z",
    eventsScored: 15,
    processedDates: ["2026-07-09"],
    weights: { "open-meteo": 0.5, kma: 0.5 },
  };

  try {
    await store.writeWeights(current);
    await assert.rejects(() => store.writeWeights(regressed), /weight state/i);
    assert.deepEqual(await store.readWeights(), current);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("batch persistence fails closed on an existing malformed weight checkpoint", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "raintoday-reliability-"));
  const store = createFileReliabilityStore(dir);
  writeFileSync(path.join(dir, "source-weights.json"), "{ malformed", "utf8");
  try {
    await assert.rejects(() => store.readWeights(), /invalid reliability weight state/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot replacement propagates non-missing weight unlink failures", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "raintoday-reliability-"));
  mkdirSync(path.join(dir, "source-weights.json"));
  try {
    await assert.rejects(
      () => writeReliabilitySnapshot(dir, { forecasts: [], dailySkill: [], weights: null }),
      /directory|EISDIR|EPERM/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
