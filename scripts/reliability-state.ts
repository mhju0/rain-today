/**
 * Manual inspection/recovery utilities. Scheduled restore, validation, and
 * publication are owned by runReliabilityStateTransaction.
 */
import {
  readReliabilitySnapshot,
  writeReliabilitySnapshot,
} from "../lib/reliability/persistence.ts";
import {
  assertReliabilitySnapshotMonotonic,
  mergeReliabilitySnapshots,
} from "../lib/reliability/stateSnapshot.ts";

function usage(): never {
  throw new Error(
    "Usage: reliability-state.ts recover <known-good-dir> <current-dir> | assert-monotonic <previous-dir> <candidate-dir> [--allow-content-repair]",
  );
}

function describe(label: string, snapshot: Awaited<ReturnType<typeof readReliabilitySnapshot>>): string {
  const weights = snapshot.weights
    ? `${snapshot.weights.eventsScored} events @ ${snapshot.weights.updatedAt}`
    : "no valid weights";
  return `${label}: ${snapshot.forecasts.length} forecast row(s), ${snapshot.dailySkill.length} skill row(s), ${weights}`;
}

async function main(): Promise<void> {
  const [command, firstDir, secondDir, option, ...extra] = process.argv.slice(2);
  if (!command || !firstDir || !secondDir || extra.length > 0) usage();
  const allowContentRepair = option === "--allow-content-repair";
  if (option && !allowContentRepair) usage();
  if (command !== "assert-monotonic" && allowContentRepair) usage();

  const first = await readReliabilitySnapshot(firstDir);
  const second = await readReliabilitySnapshot(secondDir);

  if (command === "assert-monotonic") {
    assertReliabilitySnapshotMonotonic(first, second, { allowContentRepair });
    console.log(describe("previous", first));
    console.log(describe("candidate", second));
    console.log("reliability state is monotonic; safe to persist");
    return;
  }

  if (command === "recover") {
    const merged = mergeReliabilitySnapshots(first, second);
    assertReliabilitySnapshotMonotonic(second, merged, { allowContentRepair: true });
    await writeReliabilitySnapshot(secondDir, merged);
    console.log(describe("known-good", first));
    console.log(describe("current", second));
    console.log(describe("recovered", merged));
    return;
  }

  usage();
}

main().catch((error) => {
  console.error("[reliability-state] fatal:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
