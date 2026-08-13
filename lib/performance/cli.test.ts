import assert from "node:assert/strict";
import test from "node:test";
import { resolveCaptureCohort } from "./cli.ts";

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
