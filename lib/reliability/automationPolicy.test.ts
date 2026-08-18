import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const { load: parseYaml } = createRequire(import.meta.url)("js-yaml") as {
  load(source: string): unknown;
};

interface WorkflowStep {
  env?: Record<string, unknown>;
  if?: unknown;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface ReliabilityWorkflow {
  concurrency?: unknown;
  jobs?: {
    run?: {
      permissions?: unknown;
      "runs-on"?: unknown;
      steps?: WorkflowStep[];
    };
  };
  name?: unknown;
  on?: unknown;
  permissions?: unknown;
}

const workflowPath = path.resolve(".github/workflows/precip-reliability.yml");

async function readWorkflow(): Promise<ReliabilityWorkflow> {
  const source = await readFile(workflowPath, "utf8");
  const parsed = parseYaml(source);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as ReliabilityWorkflow;
}

async function runWorkflowShell(
  command: string,
  recoveryRef: string,
): Promise<{ args: string[]; calls: number }> {
  const root = await mkdtemp(path.join(tmpdir(), "raintoday-workflow-policy-"));
  try {
    const bin = path.join(root, "bin");
    const argsFile = path.join(root, "npm-args");
    const callsFile = path.join(root, "npm-calls");
    const npm = path.join(bin, "npm");
    await mkdir(bin);
    await writeFile(
      npm,
      '#!/usr/bin/env bash\nprintf "call\\n" >> "$NPM_CALLS_FILE"\nprintf "%s\\0" "$@" >> "$NPM_ARGS_FILE"\n',
      "utf8",
    );
    await chmod(npm, 0o755);

    await execFileAsync(
      "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", command],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NPM_ARGS_FILE: argsFile,
          NPM_CALLS_FILE: callsFile,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RECOVERY_REF: recoveryRef,
        },
      },
    );

    const args = (await readFile(argsFile, "utf8")).split("\0").filter(Boolean);
    const calls = (await readFile(callsFile, "utf8")).trim().split("\n").length;
    return { args, calls };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("reliability workflow preserves its trigger, authorization, and secret policy around one transaction step", async () => {
  const workflow = await readWorkflow();
  const job = workflow.jobs?.run;
  assert.ok(job);
  assert.equal(workflow.name, "precip-reliability");
  assert.deepEqual(workflow.on, {
    workflow_dispatch: {
      inputs: {
        recovery_ref: {
          description: "Optional full 40-char known-good commit SHA or remote ref to union before this run",
          required: false,
          type: "string",
        },
      },
    },
    schedule: [{ cron: "10 21 * * *" }],
  });
  assert.deepEqual(workflow.concurrency, {
    group: "precip-reliability",
    "cancel-in-progress": false,
  });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.deepEqual(job.permissions, { contents: "write" });

  const steps = job.steps;
  assert.ok(steps);
  assert.equal(steps.length, 3);
  assert.equal(
    steps[0]?.uses,
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  );
  assert.notEqual(steps[0]?.with?.["persist-credentials"], false);
  assert.equal(
    steps[1]?.uses,
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  );
  assert.deepEqual(steps[1]?.with, { "node-version": "24" });
  assert.deepEqual(steps[2]?.env, {
    RECOVERY_REF: "${{ inputs.recovery_ref }}",
    MET_NO_USER_AGENT: "${{ secrets.MET_NO_USER_AGENT }}",
    KMA_SHORT_TERM_API_KEY: "${{ secrets.KMA_SHORT_TERM_API_KEY }}",
    PIRATE_WEATHER_API_KEY: "${{ secrets.PIRATE_WEATHER_API_KEY }}",
    WEATHERAPI_KEY: "${{ secrets.WEATHERAPI_KEY }}",
    KMA_OBSERVATION_API_KEY: "${{ secrets.KMA_OBSERVATION_API_KEY }}",
    RELIABILITY_ETA: "${{ secrets.RELIABILITY_ETA }}",
  });
  assert.ok(steps.every((step) => step.if === undefined));

  const shell = steps.flatMap((step) => (step.run ? [step.run] : [])).join("\n");
  assert.doesNotMatch(shell, /\bgit\s+(?:show|worktree)\b/);
  assert.doesNotMatch(shell, /\bcp\s+-f\b/);
  assert.doesNotMatch(shell, /\balways\s*\(/);
  assert.doesNotMatch(shell, /\bfor\s+\w+\s+in\b/);
});

test("reliability workflow invokes the transactional CLI once and forwards only an explicit recovery ref", async () => {
  const workflow = await readWorkflow();
  const transaction = workflow.jobs?.run?.steps?.[2];
  assert.ok(transaction?.run);

  assert.deepEqual(await runWorkflowShell(transaction.run, ""), {
    args: ["run", "reliability:daily", "--"],
    calls: 1,
  });
  assert.deepEqual(
    await runWorkflowShell(transaction.run, "refs/tags/known good; untouched"),
    {
      args: [
        "run",
        "reliability:daily",
        "--",
        "--recover",
        "refs/tags/known good; untouched",
      ],
      calls: 1,
    },
  );
});

test("Vercel excludes the public reliability-state branch from deployments", async () => {
  const source = await readFile(path.resolve("vercel.json"), "utf8").catch(() => null);
  assert.ok(source, "vercel.json must define branch deployment policy");
  assert.deepEqual(JSON.parse(source), {
    $schema: "https://openapi.vercel.sh/vercel.json",
    git: {
      deploymentEnabled: {
        "reliability-state": false,
      },
    },
  });
});
