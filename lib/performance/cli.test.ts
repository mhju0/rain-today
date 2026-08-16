import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { resolveCaptureCohort, SCHEDULE_COHORTS } from "./cli.ts";

test("manual capture cohort takes precedence over schedule metadata", () => {
  assert.equal(
    resolveCaptureCohort(["--cohort=18", "--schedule=10 21 * * *"]),
    "18",
  );
});

test("scheduled cohort comes from the triggering cron, not the delayed start hour", () => {
  assert.equal(resolveCaptureCohort(["--cohort=", "--schedule=10 21 * * *"]), "06");
  assert.equal(resolveCaptureCohort(["--cohort=", "--schedule=10 9 * * *"]), "18");
});

test("capture cohort rejects unknown or missing trigger metadata", () => {
  assert.throws(() => resolveCaptureCohort([]), /cohort/);
  assert.throws(() => resolveCaptureCohort(["--schedule=10 8 * * *"]), /schedule/);
  assert.throws(() => resolveCaptureCohort(["--cohort=07"]), /cohort/);
});

test("every scheduled cron in the capture workflow resolves to a cohort", () => {
  const workflow = readFileSync(
    join(import.meta.dirname, "..", "..", ".github", "workflows", "local-performance.yml"),
    "utf8",
  );
  const crons = Array.from(workflow.matchAll(/^\s*-\s*cron:\s*"([^"]+)"/gm), (m) => m[1]);

  assert.ok(crons.length > 0, "workflow declares no cron schedules");
  for (const cron of crons) {
    assert.equal(
      resolveCaptureCohort([`--schedule=${cron}`]),
      SCHEDULE_COHORTS[cron],
      `workflow cron ${cron} has no capture cohort`,
    );
  }
  assert.deepEqual(
    crons.slice().sort(),
    Object.keys(SCHEDULE_COHORTS).sort(),
    "capture cohort table and workflow crons have drifted",
  );
});
