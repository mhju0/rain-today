import type { CaptureCohort } from "./types.ts";

const SCHEDULE_COHORTS: Readonly<Record<string, CaptureCohort>> = {
  "10 21 * * *": "06",
  "10 9 * * *": "18",
};

function option(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = argv.find((argument) => argument.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** Resolve one fixed cohort from explicit dispatch input or the triggering cron. */
export function resolveCaptureCohort(argv: readonly string[]): CaptureCohort {
  const cohort = option(argv, "cohort");
  if (cohort) {
    if (cohort === "06" || cohort === "18") return cohort;
    throw new Error("--cohort must be 06 or 18");
  }
  const schedule = option(argv, "schedule");
  if (!schedule) throw new Error("--cohort or --schedule is required");
  const scheduledCohort = SCHEDULE_COHORTS[schedule];
  if (!scheduledCohort) throw new Error("--schedule is not a supported capture cohort");
  return scheduledCohort;
}
