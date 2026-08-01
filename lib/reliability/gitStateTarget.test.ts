import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  type GitCommandRunner,
  GitStateConflictError,
  GitStatePublicationError,
  GitStateTarget,
} from "./gitStateTarget.ts";
import { writeReliabilitySnapshot } from "./persistence.ts";
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

async function branchExists(repository: string, branch: string): Promise<boolean> {
  return git(repository, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`)
    .then(() => true)
    .catch(() => false);
}

async function rewriteStateBranch(
  fixture: RepositoryFixture,
  kind: "symlink" | "mode",
): Promise<void> {
  const malformedRepository = path.join(fixture.root, `malformed-${kind}`);
  await git(
    fixture.root,
    "clone",
    "--branch",
    "reliability-state",
    fixture.bareRepository,
    malformedRepository,
  );
  const forecastPath = path.join(malformedRepository, "data", "reliability", "forecast-log.jsonl");
  if (kind === "symlink") {
    await rm(forecastPath);
    await symlink("source-weights.json", forecastPath);
  } else {
    await chmod(forecastPath, 0o755);
  }
  await git(malformedRepository, "add", "--all", "--", "data/reliability");
  await git(
    malformedRepository,
    "-c",
    "user.name=Malformed Fixture",
    "-c",
    "user.email=malformed@example.test",
    "commit",
    "-m",
    `malformed ${kind} state`,
  );
  await git(
    malformedRepository,
    "push",
    "--force",
    "origin",
    "HEAD:refs/heads/reliability-state",
  );
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

test("explicit recovery reads a remote ref that is absent from the local checkout", async () => {
  await withRepository(async ({ bareRepository, target, workingRepository }) => {
    const state = snapshot(1);
    const published = await target.publish({
      expectedRevision: null,
      snapshot: state,
      message: "publish initial reliability state",
    });
    const recoveryRef = "refs/heads/recovery-checkpoint";
    await git(bareRepository, "update-ref", recoveryRef, published.revision);
    await assert.rejects(
      () => git(workingRepository, "rev-parse", "--verify", recoveryRef),
    );

    assert.deepEqual(await target.read(recoveryRef), {
      revision: published.revision,
      snapshot: state,
    });
    assert.equal(
      await git(workingRepository, "for-each-ref", "--format=%(refname)", "refs/seoulsky/recovery"),
      "",
    );
  });
});

test("explicit recovery fetches a full remote commit SHA missing from the local object store", async () => {
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
    const writerRepository = path.join(root, "recovery-writer");
    await git(
      root,
      "clone",
      "--branch",
      "reliability-state",
      bareRepository,
      writerRepository,
    );
    const writer = new GitStateTarget({
      repository: writerRepository,
      temporaryDirectory,
    });
    const remoteOnly = await writer.publish({
      expectedRevision: first.revision,
      snapshot: snapshot(2),
      message: "publish remote recovery checkpoint",
    });
    await assert.rejects(
      () => git(workingRepository, "cat-file", "-e", `${remoteOnly.revision}^{commit}`),
    );

    assert.deepEqual(await target.read(remoteOnly.revision), {
      revision: remoteOnly.revision,
      snapshot: snapshot(2),
    });
    assert.equal(
      await git(workingRepository, "for-each-ref", "--format=%(refname)", "refs/seoulsky/recovery"),
      "",
    );
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

test("concurrent fetches from different remotes do not share FETCH_HEAD state", async () => {
  await withRepository(async (fixture) => {
    await fixture.target.publish({
      expectedRevision: null,
      snapshot: snapshot(1),
      message: "publish initial reliability state",
    });
    const alternateBare = path.join(fixture.root, "alternate.git");
    const alternateWorking = path.join(fixture.root, "alternate-working");
    await git(fixture.root, "init", "--bare", alternateBare);
    await git(
      fixture.root,
      "clone",
      "--branch",
      "reliability-state",
      fixture.bareRepository,
      alternateWorking,
    );
    await writeReliabilitySnapshot(
      path.join(alternateWorking, "data", "reliability"),
      snapshot(2),
    );
    await git(alternateWorking, "add", "--all", "--", "data/reliability");
    await git(
      alternateWorking,
      "-c",
      "user.name=Alternate Fixture",
      "-c",
      "user.email=alternate@example.test",
      "commit",
      "-m",
      "alternate reliability state",
    );
    await git(alternateWorking, "remote", "set-url", "origin", alternateBare);
    await git(alternateWorking, "push", "origin", "HEAD:refs/heads/reliability-state");
    await git(fixture.workingRepository, "remote", "add", "alternate", alternateBare);

    let concurrentFetchStarted = false;
    const alternateTarget = new GitStateTarget({
      remote: "alternate",
      repository: fixture.workingRepository,
      temporaryDirectory: fixture.temporaryDirectory,
    });
    const originRunner: GitCommandRunner = async (args, options) => {
      const { stderr, stdout } = await execFileAsync("git", [...args], {
        cwd: options.cwd,
        encoding: "utf8",
      });
      if (!concurrentFetchStarted && args[0] === "fetch") {
        concurrentFetchStarted = true;
        await alternateTarget.read();
      }
      return { stderr, stdout };
    };
    const originTarget = new GitStateTarget({
      commandRunner: originRunner,
      repository: fixture.workingRepository,
      temporaryDirectory: fixture.temporaryDirectory,
    });

    const originState = await originTarget.read();
    assert.ok(originState);
    assert.deepEqual(originState.snapshot, snapshot(1));
    assert.equal(concurrentFetchStarted, true);
  });
});

for (const malformedKind of ["symlink", "mode"] as const) {
  test(`read rejects a committed ${malformedKind} reliability file`, async () => {
    await withRepository(async (fixture) => {
      await fixture.target.publish({
        expectedRevision: null,
        snapshot: snapshot(1),
        message: "publish initial reliability state",
      });
      await rewriteStateBranch(fixture, malformedKind);

      await assert.rejects(
        () => fixture.target.read(),
        /manifest|100644|100755|regular file/i,
      );
    });
  });
}

for (const raceKind of ["delete", "rewind"] as const) {
  test(`guarded lease rejects a remote ${raceKind} after the final fetch`, async () => {
    await withRepository(async (fixture) => {
      const first = await fixture.target.publish({
        expectedRevision: null,
        snapshot: snapshot(1),
        message: "publish initial reliability state",
      });
      const second = await fixture.target.publish({
        expectedRevision: first.revision,
        snapshot: snapshot(2),
        message: "publish second reliability state",
      });
      let commitFinished = false;
      let finalFetchObserved = false;
      const commandRunner: GitCommandRunner = async (args, options) => {
        const { stderr, stdout } = await execFileAsync("git", [...args], {
          cwd: options.cwd,
          encoding: "utf8",
        });
        if (args.includes("commit")) commitFinished = true;
        if (commitFinished && args[0] === "fetch" && !finalFetchObserved) {
          finalFetchObserved = true;
          if (raceKind === "delete") {
            await git(
              fixture.bareRepository,
              "update-ref",
              "-d",
              "refs/heads/reliability-state",
            );
          } else {
            await git(
              fixture.bareRepository,
              "update-ref",
              "refs/heads/reliability-state",
              first.revision,
            );
          }
        }
        return { stderr, stdout };
      };
      const racingTarget = new GitStateTarget({
        commandRunner,
        repository: fixture.workingRepository,
        temporaryDirectory: fixture.temporaryDirectory,
      });

      await assert.rejects(
        () =>
          racingTarget.publish({
            expectedRevision: second.revision,
            snapshot: snapshot(3),
            message: `race ${raceKind}`,
          }),
        GitStateConflictError,
      );
      assert.equal(finalFetchObserved, true);
    });
  });
}

test("push response loss recognizes the candidate revision already published", async () => {
  await withRepository(async (fixture) => {
    const first = await fixture.target.publish({
      expectedRevision: null,
      snapshot: snapshot(1),
      message: "publish initial reliability state",
    });
    let responseLost = false;
    const commandRunner: GitCommandRunner = async (args, options) => {
      const { stderr, stdout } = await execFileAsync("git", [...args], {
        cwd: options.cwd,
        encoding: "utf8",
      });
      if (!responseLost && args[0] === "push") {
        responseLost = true;
        throw new Error("simulated lost push response");
      }
      return { stderr, stdout };
    };
    const target = new GitStateTarget({
      commandRunner,
      repository: fixture.workingRepository,
      temporaryDirectory: fixture.temporaryDirectory,
    });

    const published = await target.publish({
      expectedRevision: first.revision,
      snapshot: snapshot(2),
      message: "publish with lost response",
    });
    assert.equal(published.changed, true);
    assert.equal(responseLost, true);
  });
});

test("published revision is preserved when worktree cleanup fails", async () => {
  await withRepository(async (fixture) => {
    const first = await fixture.target.publish({
      expectedRevision: null,
      snapshot: snapshot(1),
      message: "publish initial reliability state",
    });
    let cleanupFailed = false;
    const commandRunner: GitCommandRunner = async (args, options) => {
      const { stderr, stdout } = await execFileAsync("git", [...args], {
        cwd: options.cwd,
        encoding: "utf8",
      });
      if (!cleanupFailed && args[0] === "worktree" && args[1] === "remove") {
        cleanupFailed = true;
        throw new Error("simulated cleanup failure");
      }
      return { stderr, stdout };
    };
    const target = new GitStateTarget({
      commandRunner,
      repository: fixture.workingRepository,
      temporaryDirectory: fixture.temporaryDirectory,
    });

    let publicationError: unknown;
    await assert.rejects(
      () =>
        target.publish({
          expectedRevision: first.revision,
          snapshot: snapshot(2),
          message: "publish with cleanup failure",
        }),
      (error: unknown) => {
        publicationError = error;
        return true;
      },
    );
    assert.ok(publicationError instanceof GitStatePublicationError);
    assert.match(publicationError.message, /published (?:at )?revision/i);
    assert.equal(
      publicationError.publishedRevision,
      await git(fixture.bareRepository, "rev-parse", "refs/heads/reliability-state"),
    );
    assert.equal(cleanupFailed, true);
  });
});

test("orphan checkout failure preserves a pre-existing local branch", async () => {
  await withRepository(async (fixture) => {
    let collidedBranch: string | undefined;
    const commandRunner: GitCommandRunner = async (args, options) => {
      if (args[0] === "checkout" && args[1] === "--orphan") {
        collidedBranch = String(args[2]);
        await git(options.cwd, "branch", collidedBranch, "HEAD");
        throw new Error("simulated orphan checkout failure");
      }
      const { stderr, stdout } = await execFileAsync("git", [...args], {
        cwd: options.cwd,
        encoding: "utf8",
      });
      return { stderr, stdout };
    };
    const target = new GitStateTarget({
      commandRunner,
      repository: fixture.workingRepository,
      temporaryDirectory: fixture.temporaryDirectory,
    });

    await assert.rejects(
      () =>
        target.publish({
          expectedRevision: null,
          snapshot: snapshot(1),
          message: "publish colliding reliability state",
        }),
      /simulated orphan checkout failure/i,
    );
    assert.ok(collidedBranch);
    assert.equal(await branchExists(fixture.workingRepository, collidedBranch), true);
  });
});

test("worktree registration is cleaned when add succeeds then reports failure", async () => {
  await withRepository(async (fixture) => {
    await fixture.target.publish({
      expectedRevision: null,
      snapshot: snapshot(1),
      message: "publish initial reliability state",
    });
    let addFailedAfterRegistration = false;
    const commandRunner: GitCommandRunner = async (args, options) => {
      const { stderr, stdout } = await execFileAsync("git", [...args], {
        cwd: options.cwd,
        encoding: "utf8",
      });
      if (!addFailedAfterRegistration && args[0] === "worktree" && args[1] === "add") {
        addFailedAfterRegistration = true;
        throw new Error("simulated worktree add response failure");
      }
      return { stderr, stdout };
    };
    const target = new GitStateTarget({
      commandRunner,
      repository: fixture.workingRepository,
      temporaryDirectory: fixture.temporaryDirectory,
    });

    await assert.rejects(
      () => target.read(),
      /simulated worktree add response failure/i,
    );
    assert.equal(addFailedAfterRegistration, true);
    assert.deepEqual(await readdir(fixture.temporaryDirectory), []);
    assert.doesNotMatch(
      await git(fixture.workingRepository, "worktree", "list", "--porcelain"),
      /seoulsky-reliability-git-/,
    );
  });
});

test("read rejects option-shaped refs before invoking Git revision parsing", async () => {
  await withRepository(async ({ target }) => {
    await assert.rejects(() => target.read("--help"), /invalid git ref/i);
    await assert.rejects(() => target.read("@"), /invalid git ref/i);
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
