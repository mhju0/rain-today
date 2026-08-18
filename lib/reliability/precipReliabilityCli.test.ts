import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const script = path.resolve("scripts/precip-reliability.ts");

test("the scheduled CLI rejects repeated --recover options before any Git operation", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "raintoday-reliability-cli-"));
  try {
    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [script, "--recover", "refs/tags/first", "--recover", "refs/tags/second"],
          { cwd, encoding: "utf8", timeout: 5_000 },
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error && "stderr" in error);
        assert.match(String(error.stderr), /--recover may only be specified once/i);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
