import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  assertReliabilityStateFiles,
  readReliabilitySnapshot,
  RELIABILITY_STATE_FILES,
  writeReliabilitySnapshot,
} from "./persistence.ts";
import type { ReliabilitySnapshot } from "./stateSnapshot.ts";

const execFileAsync = promisify(execFile);

const STATE_BRANCH = "reliability-state";
const STATE_REF = `refs/heads/${STATE_BRANCH}`;
const STATE_DIRECTORY = path.join("data", "reliability");
const STATE_PATHS = RELIABILITY_STATE_FILES.map((file) => path.join(STATE_DIRECTORY, file));
const TEMPORARY_PREFIX = "seoulsky-reliability-git-";

export interface GitCommandResult {
  stderr: string;
  stdout: string;
}

export type GitCommandRunner = (
  args: readonly string[],
  options: { cwd: string },
) => Promise<GitCommandResult>;

export interface GitStateTargetOptions {
  commandRunner?: GitCommandRunner;
  remote?: string;
  repository: string;
  temporaryDirectory?: string;
}

export interface VersionedReliabilitySnapshot {
  revision: string;
  snapshot: ReliabilitySnapshot;
}

export interface GitStatePublicationRequest {
  expectedRevision: string | null;
  message: string;
  snapshot: ReliabilitySnapshot;
}

export interface GitStatePublicationResult {
  changed: boolean;
  revision: string;
}

export class GitStateConflictError extends Error {
  readonly expectedRevision: string | null;
  readonly observedRevision: string | null;

  constructor(
    expectedRevision: string | null,
    observedRevision: string | null,
  ) {
    super(
      `Reliability state revision conflict: expected ${expectedRevision ?? "<missing>"}, ` +
        `observed ${observedRevision ?? "<missing>"}`,
    );
    this.name = "GitStateConflictError";
    this.expectedRevision = expectedRevision;
    this.observedRevision = observedRevision;
  }
}

async function defaultCommandRunner(
  args: readonly string[],
  options: { cwd: string },
): Promise<GitCommandResult> {
  const { stderr, stdout } = await execFileAsync("git", [...args], {
    cwd: options.cwd,
    encoding: "utf8",
  });
  return { stderr, stdout };
}

function hasExitCode(error: unknown, expected: number): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "number" &&
    error.code === expected
  );
}

function assertRemoteName(remote: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) {
    throw new Error(`Invalid Git remote name: ${remote}`);
  }
}

function assertRevision(revision: string, label: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(revision)) {
    throw new Error(`Invalid ${label}: ${revision}`);
  }
}

function assertGitRef(ref: string): void {
  const components = ref.split("/");
  if (
    !ref ||
    ref.startsWith("-") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.includes("@{") ||
    /[\x00-\x20\x7f~^:?*[\\]/.test(ref) ||
    components.some((component) => component.startsWith(".") || component.endsWith(".lock"))
  ) {
    throw new Error(`Invalid Git ref: ${ref}`);
  }
}

function orderDiscoveredManifest(files: readonly string[]): string[] {
  const canonical = new Set<string>(RELIABILITY_STATE_FILES);
  return [
    ...RELIABILITY_STATE_FILES.filter((file) => files.includes(file)),
    ...files.filter((file) => !canonical.has(file)),
  ];
}

/** Git-backed durable target for the canonical Reliability Snapshot. */
export class GitStateTarget {
  private readonly commandRunner: GitCommandRunner;
  private readonly remote: string;
  private readonly repository: string;
  private readonly temporaryDirectory: string;

  constructor(options: GitStateTargetOptions) {
    if (!options.repository.trim()) throw new Error("Git repository path is required");
    this.repository = path.resolve(options.repository);
    this.remote = options.remote ?? "origin";
    assertRemoteName(this.remote);
    this.temporaryDirectory = path.resolve(options.temporaryDirectory ?? tmpdir());
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
  }

  async read(ref?: string): Promise<VersionedReliabilitySnapshot | null> {
    let revision: string | null;
    if (ref === undefined) {
      revision = await this.fetchStateRevision();
      if (revision === null) return null;
    } else {
      assertGitRef(ref);
      revision = await this.resolveCommit(ref);
      if (revision === null) throw new Error(`Git ref does not resolve to a commit: ${ref}`);
    }

    await this.assertCommittedManifest(revision);
    return this.withTemporaryWorktree(revision, undefined, async (worktree) => ({
      revision,
      snapshot: await readReliabilitySnapshot(path.join(worktree, STATE_DIRECTORY)),
    }));
  }

  async publish(request: GitStatePublicationRequest): Promise<GitStatePublicationResult> {
    this.assertPublicationRequest(request);
    const observedRevision = await this.fetchStateRevision();
    this.assertExpectedRevision(request.expectedRevision, observedRevision);

    const baseRevision = observedRevision ?? (await this.requireHeadRevision());
    const temporaryBranch = observedRevision === null ? this.temporaryBranchName() : undefined;

    return this.withTemporaryWorktree(
      baseRevision,
      temporaryBranch,
      async (worktree): Promise<GitStatePublicationResult> => {
        if (temporaryBranch) {
          await this.git(["checkout", "--orphan", temporaryBranch], worktree);
          await this.git(["rm", "-r", "--force", "--ignore-unmatch", "--", "."], worktree);
        } else {
          await this.assertCommittedManifest(baseRevision);
        }

        const stateDirectory = path.join(worktree, STATE_DIRECTORY);
        await writeReliabilitySnapshot(stateDirectory, request.snapshot);
        await this.assertCandidateManifest(stateDirectory);
        await this.git(["add", "--all", "--", ...STATE_PATHS], worktree);

        if (!(await this.hasStagedChanges(worktree))) {
          const refreshedRevision = await this.fetchStateRevision();
          this.assertExpectedRevision(request.expectedRevision, refreshedRevision);
          if (refreshedRevision === null) {
            throw new Error("A first reliability-state publication cannot be unchanged");
          }
          return { changed: false, revision: refreshedRevision };
        }

        await this.git(
          [
            "-c",
            "user.name=SeoulSky Reliability",
            "-c",
            "user.email=reliability@seoulsky.local",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            request.message,
          ],
          worktree,
        );
        const revision = await this.requireCommit("HEAD", worktree);
        await this.assertCommittedManifest(revision);

        const refreshedRevision = await this.fetchStateRevision();
        this.assertExpectedRevision(request.expectedRevision, refreshedRevision);
        try {
          await this.git(["push", this.remote, `HEAD:${STATE_REF}`], worktree);
        } catch (error) {
          const revisionAfterFailure = await this.fetchStateRevision().catch(() => refreshedRevision);
          if (revisionAfterFailure !== request.expectedRevision) {
            throw new GitStateConflictError(request.expectedRevision, revisionAfterFailure);
          }
          throw error;
        }

        return { changed: true, revision };
      },
    );
  }

  private assertPublicationRequest(request: GitStatePublicationRequest): void {
    if (request.expectedRevision !== null) {
      assertRevision(request.expectedRevision, "expected reliability state revision");
    }
    if (!request.message.trim()) throw new Error("Reliability state commit message is required");
  }

  private async git(args: readonly string[], cwd = this.repository): Promise<GitCommandResult> {
    return this.commandRunner(args, { cwd });
  }

  private async fetchStateRevision(): Promise<string | null> {
    try {
      await this.git(["ls-remote", "--exit-code", "--heads", this.remote, STATE_REF]);
    } catch (error) {
      if (hasExitCode(error, 2)) return null;
      throw error;
    }

    await this.git(["fetch", "--no-tags", this.remote, STATE_REF]);
    const revision = await this.resolveCommit("FETCH_HEAD");
    if (revision === null) throw new Error(`Fetched ${STATE_REF} did not resolve to a commit`);
    return revision;
  }

  private async resolveCommit(ref: string): Promise<string | null> {
    try {
      const { stdout } = await this.git([
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${ref}^{commit}`,
      ]);
      const revision = stdout.trim();
      assertRevision(revision, "resolved Git revision");
      return revision;
    } catch (error) {
      if (hasExitCode(error, 1)) return null;
      throw error;
    }
  }

  private async requireHeadRevision(): Promise<string> {
    const revision = await this.resolveCommit("HEAD");
    if (revision === null) {
      throw new Error("First reliability-state publication requires an existing repository commit");
    }
    return revision;
  }

  private async requireCommit(ref: string, cwd: string): Promise<string> {
    const { stdout } = await this.git(
      ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      cwd,
    );
    const revision = stdout.trim();
    assertRevision(revision, "committed Git revision");
    return revision;
  }

  private assertExpectedRevision(expected: string | null, observed: string | null): void {
    if (expected !== observed) throw new GitStateConflictError(expected, observed);
  }

  private async assertCandidateManifest(stateDirectory: string): Promise<void> {
    const entries = await readdir(stateDirectory, { withFileTypes: true });
    const discovered = entries.map((entry) => (entry.isFile() ? entry.name : `${entry.name}/`));
    assertReliabilityStateFiles(orderDiscoveredManifest(discovered));
  }

  private async assertCommittedManifest(revision: string): Promise<void> {
    const { stdout } = await this.git(["ls-tree", "-r", "--name-only", revision, "--"]);
    const prefix = `${STATE_DIRECTORY.split(path.sep).join("/")}/`;
    const committedPaths = stdout
      .split("\n")
      .map((file) => file.trim())
      .filter(Boolean);
    const discovered = committedPaths.map((file) =>
      file.startsWith(prefix) && !file.slice(prefix.length).includes("/")
        ? file.slice(prefix.length)
        : file,
    );
    assertReliabilityStateFiles(orderDiscoveredManifest(discovered));
  }

  private async hasStagedChanges(worktree: string): Promise<boolean> {
    try {
      await this.git(["diff", "--cached", "--quiet", "--exit-code", "--", ...STATE_PATHS], worktree);
      return false;
    } catch (error) {
      if (hasExitCode(error, 1)) return true;
      throw error;
    }
  }

  private temporaryBranchName(): string {
    return `reliability-publication-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
  }

  private async withTemporaryWorktree<T>(
    revision: string,
    temporaryBranch: string | undefined,
    run: (worktree: string) => Promise<T>,
  ): Promise<T> {
    await mkdir(this.temporaryDirectory, { recursive: true });
    const worktree = await mkdtemp(path.join(this.temporaryDirectory, TEMPORARY_PREFIX));
    let worktreeAdded = false;
    let result: T | undefined;
    let operationFailed = false;
    let operationError: unknown;

    try {
      await this.git(["worktree", "add", "--detach", worktree, revision]);
      worktreeAdded = true;
      result = await run(worktree);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    const cleanupError = await this.cleanupWorktree(worktree, worktreeAdded, temporaryBranch);
    if (operationFailed) throw operationError;
    if (cleanupError !== undefined) throw cleanupError;
    return result as T;
  }

  private async cleanupWorktree(
    worktree: string,
    worktreeAdded: boolean,
    temporaryBranch: string | undefined,
  ): Promise<unknown> {
    let cleanupError: unknown;
    if (worktreeAdded) {
      try {
        await this.git(["worktree", "remove", "--force", worktree]);
      } catch (error) {
        cleanupError = error;
      }
    }

    await rm(worktree, { recursive: true, force: true }).catch((error: unknown) => {
      cleanupError ??= error;
    });
    if (worktreeAdded && cleanupError !== undefined) {
      await this.git(["worktree", "prune", "--expire", "now"]).catch(() => undefined);
    }
    if (temporaryBranch) {
      await this.git(["update-ref", "-d", `refs/heads/${temporaryBranch}`]).catch(
        (error: unknown) => {
          cleanupError ??= error;
        },
      );
    }
    return cleanupError;
  }
}
