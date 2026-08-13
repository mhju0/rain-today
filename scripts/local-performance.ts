import { runPerformanceBatch } from "../lib/performance/batch.ts";
import { PostgresPerformanceStore } from "../lib/performance/postgres.ts";
import type { CaptureCohort } from "../lib/performance/types.ts";

function readCohort(argv: readonly string[]): CaptureCohort {
  const inline = argv.find((argument) => argument.startsWith("--cohort="))?.split("=")[1];
  const index = argv.indexOf("--cohort");
  const value = inline ?? (index >= 0 ? argv[index + 1] : undefined);
  if (value !== "06" && value !== "18") {
    throw new Error("--cohort must be 06 or 18");
  }
  return value;
}

async function main(): Promise<void> {
  const cohort = readCohort(process.argv.slice(2));
  const connectionUrl = process.env.PERFORMANCE_DATABASE_URL?.trim();
  if (!connectionUrl) throw new Error("PERFORMANCE_DATABASE_URL is required");
  const store = new PostgresPerformanceStore(connectionUrl);
  try {
    const result = await runPerformanceBatch({
      cohort,
      now: new Date(),
      store,
    });
    console.log(JSON.stringify({ cohort, ...result }, null, 2));
    if (result.failures.length > 0) process.exitCode = 1;
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "local performance batch failed");
  process.exitCode = 1;
});
