import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  type GitCommandRunner,
  GitStateConflictError,
  GitStateTarget,
} from "./gitStateTarget.ts";
import type { ReliabilitySnapshot } from "./stateSnapshot.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

interface RepositoryFixture {
  bareRepository: string;
  root: string;
  target: GitStateTarget;
  temporaryDirectory: string;
  workingRepository: string;
}

async function createRepositoryFixture(): Promise<RepositoryFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "seoulsky-git-state-target-test-"));
  const bareRepository = path.join(root, "remote.git");
  const workingRepository = path.join(root, "working");
  const temporaryDirectory = path.join(root, "temporary");
  await mkdir(temporaryDirectory);
  await git(root, "init", "--bare", bareRepository);
  await git(root, "init", "-b", "main", workingRepository);
  await writeFile(path.join(workingRepository, "README.md"), "release branch\n", "utf8");
  await git(workingRepository, "add", "--", "README.md");
  await git(
    workingRepository,
    "-c",
    "user.name=Fixture Author",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "seed release branch",
  );
  await git(workingRepository, "remote", "add", "origin", bareRepository);
  await git(workingRepository, "push", "-u", "origin", "HEAD:refs/heads/main");
  return {
    bareRepository,
    root,
    target: new GitStateTarget({ repository: workingRepository, temporaryDirectory }),
    temporaryDirectory,
    workingRepository,
  };
}

function snapshot(version: 1 | 2 | 3): ReliabilitySnapshot {
  const date = `2026-07-${14 + version}`;
  const forecasts = [
    {
      date,
      source: "open-meteo" as const,
      region: "seoul",
      pop: version === 1 ? 30 : 60,
      predicted_mm: version === 1 ? 1.2 : 4.5,
      loggedAt: `${date}T00:00:00.000Z`,
    },
  ];
  const dailySkill = [
    {
      date,
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
      scoredAt: `${date}T12:00:00.000Z`,
    },
  ];
  return {
    forecasts,
    dailySkill,
    weights: {
      updatedAt: `${date}T12:00:00.000Z`,
      eventsScored: version,
      processedDates: [date],
      weights: { "open-meteo": 0.6, kma: 0.4 },
    },
  };
}

async function withRepository(
  run: (fixture: RepositoryFixture) => Promise<void>,
): Promise<void> {
  const fixture = await createRepositoryFixture();
  try {
    await run(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

test("read returns null when the reliability-state branch is missing", async () => {
  await withRepository(async ({ target }) => {
    assert.equal(await target.read(), null);
  });
});

test("first publication creates an explicit root commit from a null revision", async () => {
  await withRepository(async ({ bareRepository, target }) => {
    const published = await target.publish({
      expectedRevision: null,
      snapshot: snapshot(1),
      message: "publish initial reliability state",
    });

    assert.equal(published.changed, true);
    assert.match(published.revision, /^[0-9a-f]{40}$/);
    assert.deepEqual(
      (await git(
        bareRepository,
        "rev-list",
        "--parents",
        "-n",
        "1",
        "refs/heads/reliability-state",
      )).split(" "),
      [published.revision],
    );
    assert.equal(
      await git(
        bareRepository,
        "show",
        "-s",
        "--format=%an <%ae>",
        "refs/heads/reliability-state",
      ),
      "SeoulSky Reliability <reliability@seoulsky.local>",
    );
  });
});

test("first publication rejects a non-null expected revision for a missing branch", async () => {
  await withRepository(async ({ target }) => {
    await assert.rejects(
      () =>
        target.publish({
          expectedRevision: "1111111111111111111111111111111111111111",
          snapshot: snapshot(1),
          message: "publish initial reliability state",
        }),
      GitStateConflictError,
    );
  });
});

test("read returns the published revision and snapshot", async () => {
  await withRepository(async ({ target }) => {
    const state = snapshot(1);
    const published = await target.publish({
      expectedRevision: null,
      snapshot: state,
      message: "publish initial reliability state",
    });

    assert.deepEqual(await target.read(), {
      revision: published.revision,
      snapshot: state,
    });
  });
});

test("unchanged publication returns the existing revision without a commit", async () => {
  await withRepository(async ({ bareRepository, target }) => {
    const state = snapshot(1);
    const first = await target.publish({
      expectedRevision: null,
      snapshot: state,
      message: "publish initial reliability state",
    });
    const unchanged = await target.publish({
      expectedRevision: first.revision,
      snapshot: state,
      message: "do not create this commit",
    });

    assert.deepEqual(unchanged, { changed: false, revision: first.revision });
    assert.equal(
      await git(bareRepository, "rev-list", "--count", "refs/heads/reliability-state"),
      "1",
    );
  });
});

test("second publication is a normal fast-forward commit", async () => {
  await withRepository(async ({ bareRepository, target }) => {
    const first = await target.publish({
      expectedRevision: null,
      snapshot: snapshot(1),
      message: "publish initial reliability state",
    });
    const secondState = snapshot(2);
    const second = await target.publish({
      expectedRevision: first.revision,
      snapshot: secondState,
      message: "publish next reliability state",
    });

    assert.equal(second.changed, true);
    assert.notEqual(second.revision, first.revision);
    assert.equal(
      await git(bareRepository, "rev-parse", `${second.revision}^`),
      first.revision,
    );
    assert.deepEqual(await target.read(), { revision: second.revision, snapshot: secondState });
  });
});

test("publication rejects a stale expected revision without moving the branch", async () => {
  await withRepository(async ({ bareRepository, target }) => {
    const first = await target.publish({
      expectedRevision: null,
      snapshot: snapshot(1),
      message: "publish initial reliability state",
    });
    const advanced = await target.publish({
      expectedRevision: first.revision,
      snapshot: snapshot(2),
      message: "advance reliability state",
    });

    await assert.rejects(
      () =>
        target.publish({
          expectedRevision: first.revision,
          snapshot: snapshot(1),
          message: "stale reliability state",
        }),
      (error: unknown) => {
        assert.ok(error instanceof GitStateConflictError);
        assert.equal(error.expectedRevision, first.revision);
        assert.equal(error.observedRevision, advanced.revision);
        return true;
      },
    );
    assert.equal(
      await git(bareRepository, "rev-parse", "refs/heads/reliability-state"),
      advanced.revision,
    );
  });
});

test("publication commits only the exact reliability manifest", async () => {
  await withRepository(async ({ bareRepository, target }) => {
    await target.publish({
      expectedRevision: null,
      snapshot: snapshot(1),
      message: "publish initial reliability state",
    });

    assert.deepEqual(
      (
        await git(
          bareRepository,
          "ls-tree",
          "-r",
          "--name-only",
          "refs/heads/reliability-state",
        )
      ).split("\n"),
      [
        "data/reliability/daily-skill.jsonl",
        "data/reliability/forecast-log.jsonl",
        "data/reliability/source-weights.json",
      ],
    );
  });
});

test("publication rejects a snapshot that cannot materialize the exact manifest", async () => {
  await withRepository(async ({ bareRepository, target }) => {
    await assert.rejects(
      () =>
        target.publish({
          expectedRevision: null,
          snapshot: { ...snapshot(1), weights: null },
          message: "publish incomplete reliability state",
        }),
      /unexpected reliability state file/i,
    );
    assert.equal(
      await git(bareRepository, "show-ref", "--verify", "--quiet", "refs/heads/reliability-state")
        .then(() => true)
        .catch(() => false),
      false,
    );
  });
});

test("publication detects a concurrent advance on its immediate pre-push fetch", async () => {
  await withRepository(async ({
    bareRepository,
    root,
    target,
    temporaryDirectory,
    workingRepository,
  }) => {
    const first = await target.publish({
      expectedRevision: null,
      snapshot: snapshot(1),
      message: "publish initial reliability state",
    });
    const competitorRepository = path.join(root, "competitor");
    await git(
      root,
      "clone",
      "--branch",
      "reliability-state",
      bareRepository,
      competitorRepository,
    );
    const competitor = new GitStateTarget({
      repository: competitorRepository,
      temporaryDirectory,
    });
    let advancedRevision: string | undefined;
    let concurrentPublishStarted = false;
    const commandRunner: GitCommandRunner = async (args, options) => {
      const { stderr, stdout } = await execFileAsync("git", [...args], {
        cwd: options.cwd,
        encoding: "utf8",
      });
      if (!concurrentPublishStarted && args.includes("commit")) {
        concurrentPublishStarted = true;
        advancedRevision = (
          await competitor.publish({
            expectedRevision: first.revision,
            snapshot: snapshot(2),
            message: "publish competing reliability state",
          })
        ).revision;
      }
      return { stderr, stdout };
    };
    const racingTarget = new GitStateTarget({
      commandRunner,
      repository: workingRepository,
      temporaryDirectory,
    });

    await assert.rejects(
      () =>
        racingTarget.publish({
          expectedRevision: first.revision,
          snapshot: snapshot(3),
          message: "publish stale candidate",
        }),
      (error: unknown) => {
        assert.ok(error instanceof GitStateConflictError);
        assert.equal(error.observedRevision, advancedRevision);
        return true;
      },
    );
    assert.ok(advancedRevision);
    assert.equal(
      await git(bareRepository, "rev-parse", "refs/heads/reliability-state"),
      advancedRevision,
    );
    assert.deepEqual(await readdir(temporaryDirectory), []);
  });
});

test("read rejects option-shaped refs before invoking Git revision parsing", async () => {
  await withRepository(async ({ target }) => {
    await assert.rejects(() => target.read("--help"), /invalid git ref/i);
  });
});

test("temporary publication worktrees are removed after success and conflict", async () => {
  await withRepository(async ({ target, temporaryDirectory }) => {
    const first = await target.publish({
      expectedRevision: null,
      snapshot: snapshot(1),
      message: "publish initial reliability state",
    });
    await assert.rejects(
      () =>
        target.publish({
          expectedRevision: null,
          snapshot: snapshot(2),
          message: "conflicting reliability state",
        }),
      GitStateConflictError,
    );
    assert.equal(first.changed, true);
    assert.deepEqual(await readdir(temporaryDirectory), []);
  });
});
