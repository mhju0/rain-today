import { runPerformanceBatch } from "../lib/performance/batch.ts";
import { resolveCaptureCohort } from "../lib/performance/cli.ts";
import { PostgresPerformanceStore } from "../lib/performance/postgres.ts";

async function main(): Promise<void> {
  const cohort = resolveCaptureCohort(process.argv.slice(2));
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
