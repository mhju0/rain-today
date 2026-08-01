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

export class GitStatePublicationError extends Error {
  readonly publishedRevision: string;
  readonly cause: unknown;

  constructor(publishedRevision: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Reliability state may already be published at revision ${publishedRevision}; ` +
        `publication cleanup or confirmation failed: ${detail}`,
    );
    this.name = "GitStatePublicationError";
    this.publishedRevision = publishedRevision;
    this.cause = cause;
  }
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
    ref === "@" ||
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
  private fetchSequence = 0;

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
    return this.withTemporaryWorktree(revision, undefined, async (worktree) => {
      const stateDirectory = path.join(worktree, STATE_DIRECTORY);
      await this.assertCandidateManifest(stateDirectory);
      return { revision, snapshot: await readReliabilitySnapshot(stateDirectory) };
    });
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
      async (worktree, markTemporaryBranchOwned): Promise<GitStatePublicationResult> => {
        if (temporaryBranch) {
          await this.git(["checkout", "--orphan", temporaryBranch], worktree);
          markTemporaryBranchOwned();
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
        await this.assertFastForwardCandidate(request.expectedRevision, revision, worktree);
        const lease = `--force-with-lease=${STATE_REF}:${request.expectedRevision ?? ""}`;
        try {
          await this.git(["push", lease, this.remote, `HEAD:${STATE_REF}`], worktree);
        } catch (error) {
          let revisionAfterFailure: string | null;
          try {
            revisionAfterFailure = await this.fetchStateRevision();
          } catch (refreshError) {
            throw new GitStatePublicationError(
              revision,
              new AggregateError([error, refreshError], "Unable to confirm reliability state publication"),
            );
          }
          if (revisionAfterFailure === revision) {
            return { changed: true, revision };
          }
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

    const fetchRef = `refs/seoulsky/reliability-state/${process.pid}-${this.fetchSequence++}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    let operationError: unknown;
    let revision: string | null = null;
    try {
      await this.git(["fetch", "--no-tags", this.remote, `${STATE_REF}:${fetchRef}`]);
      revision = await this.resolveCommit(fetchRef);
      if (revision === null) throw new Error(`Fetched ${STATE_REF} did not resolve to a commit`);
    } catch (error) {
      operationError = error;
    }
    let cleanupError: unknown;
    try {
      await this.git(["update-ref", "-d", fetchRef]);
    } catch (error) {
      cleanupError = error;
    }
    if (operationError !== undefined) throw operationError;
    if (cleanupError !== undefined) throw cleanupError;
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

  private async assertFastForwardCandidate(
    expectedRevision: string | null,
    candidateRevision: string,
    worktree: string,
  ): Promise<void> {
    if (expectedRevision === null) {
      const { stdout } = await this.git(["rev-list", "--parents", "-n", "1", candidateRevision], worktree);
      if (stdout.trim().split(/\s+/).length !== 1) {
        throw new Error("First reliability-state publication candidate must be a root commit");
      }
      return;
    }
    try {
      await this.git(["merge-base", "--is-ancestor", expectedRevision, candidateRevision], worktree);
    } catch (error) {
      if (hasExitCode(error, 1)) {
        throw new Error(
          `Reliability state candidate ${candidateRevision} is not a fast-forward from ${expectedRevision}`,
        );
      }
      throw error;
    }
  }

  private async assertCandidateManifest(stateDirectory: string): Promise<void> {
    const entries = await readdir(stateDirectory, { withFileTypes: true });
    const discovered = entries.map((entry) => (entry.isFile() ? entry.name : `${entry.name}/`));
    assertReliabilityStateFiles(orderDiscoveredManifest(discovered));
    for (const file of RELIABILITY_STATE_FILES) {
      const entry = entries.find((candidate) => candidate.name === file);
      if (!entry?.isFile()) throw new Error(`Reliability manifest path is not a regular file: ${file}`);
    }
  }

  private async assertCommittedManifest(revision: string): Promise<void> {
    const { stdout } = await this.git(["ls-tree", "-r", revision, "--"]);
    const prefix = `${STATE_DIRECTORY.split(path.sep).join("/")}/`;
    const entries = stdout
      .split("\n")
      .map((line) => {
        const [metadata, file] = line.split("\t");
        const [mode, type] = metadata?.split(/\s+/, 3) ?? [];
        return { file, mode, type };
      })
      .filter((entry) => Boolean(entry.file));
    const discovered = entries
      .map(({ file }) => {
        if (file?.startsWith(prefix) && !file.slice(prefix.length).includes("/")) {
          return file.slice(prefix.length);
        }
        return file ?? "<unknown>";
      })
      .filter(Boolean);
    assertReliabilityStateFiles(orderDiscoveredManifest(discovered));
    for (const entry of entries) {
      if (entry.mode !== "100644" || entry.type !== "blob") {
        throw new Error(
          `Reliability manifest path must be an ordinary 100644 blob: ${entry.file ?? "<unknown>"}`,
        );
      }
    }
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
    run: (worktree: string, markTemporaryBranchOwned: () => void) => Promise<T>,
  ): Promise<T> {
    await mkdir(this.temporaryDirectory, { recursive: true });
    const worktree = await mkdtemp(path.join(this.temporaryDirectory, TEMPORARY_PREFIX));
    let worktreeAttempted = false;
    let temporaryBranchOwned = false;
    let result: T | undefined;
    let operationFailed = false;
    let operationError: unknown;

    try {
      worktreeAttempted = true;
      await this.git(["worktree", "add", "--detach", worktree, revision]);
      result = await run(worktree, () => {
        temporaryBranchOwned = true;
      });
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    const cleanupError = await this.cleanupWorktree(
      worktree,
      worktreeAttempted,
      temporaryBranchOwned ? temporaryBranch : undefined,
    );
    if (operationFailed) throw operationError;
    if (cleanupError !== undefined) {
      if (
        result &&
        typeof result === "object" &&
        "changed" in result &&
        result.changed === true &&
        "revision" in result &&
        typeof result.revision === "string"
      ) {
        throw new GitStatePublicationError(result.revision, cleanupError);
      }
      throw cleanupError;
    }
    return result as T;
  }

  private async cleanupWorktree(
    worktree: string,
    worktreeAttempted: boolean,
    temporaryBranch: string | undefined,
  ): Promise<unknown> {
    let cleanupError: unknown;
    if (worktreeAttempted) {
      try {
        await this.git(["worktree", "remove", "--force", worktree]);
      } catch (error) {
        cleanupError = error;
      }
    }

    await rm(worktree, { recursive: true, force: true }).catch((error: unknown) => {
      cleanupError ??= error;
    });
    if (worktreeAttempted && cleanupError !== undefined) {
      await this.git(["worktree", "prune", "--expire", "now"]).catch(() => undefined);
    }
    if (temporaryBranch) {
      try {
        await this.git(["update-ref", "-d", `refs/heads/${temporaryBranch}`]);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    return cleanupError;
  }
}
