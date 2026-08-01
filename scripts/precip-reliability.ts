/** CLI adapter for the dependency-injected daily reliability cycle. */
import { parseArgs } from "node:util";
import { providers } from "../lib/providers/registry.ts";
import { runReliabilityCycle } from "../lib/reliability/cycle.ts";
import { collectForecasts } from "../lib/reliability/forecastLog.ts";
import { GitStateTarget } from "../lib/reliability/gitStateTarget.ts";
import { fetchObservedPrecip } from "../lib/reliability/groundTruth.ts";
import { runReliabilityStateTransaction } from "../lib/reliability/stateTransaction.ts";
import { resolveEta } from "../lib/reliability/weights.ts";

async function main(): Promise<void> {
  const { tokens, values } = parseArgs({
    allowPositionals: false,
    args: process.argv.slice(2),
    options: { recover: { type: "string" } },
    strict: true,
    tokens: true,
  });
  if (tokens.filter((token) => token.kind === "option" && token.name === "recover").length > 1) {
    throw new Error("Usage: --recover may only be specified once");
  }
  const recoveryRef = values.recover?.trim();
  if (values.recover !== undefined && !recoveryRef) {
    throw new Error("Usage: precip-reliability.ts [--recover <git-ref>]");
  }

  const eta = resolveEta();
  const transaction = await runReliabilityStateTransaction(
    {
      target: new GitStateTarget({ repository: process.cwd() }),
      runCycle: runReliabilityCycle,
      now: () => new Date(),
      sourceIds: providers.map((provider) => provider.id),
      collectForecasts,
      fetchObservation: fetchObservedPrecip,
      eta,
    },
    recoveryRef ? { recoveryRef } : undefined,
  );
  const result = transaction.cycle;

  console.log(
    `precip-reliability · run ${result.runAt} · ${transaction.outcome} reliability-state ${transaction.revision}`,
  );
  if (recoveryRef) console.log(`[recovery] unioned explicit checkpoint ${recoveryRef}`);
  console.log(
    `[forecast] ${result.forecast.date}: ${result.forecast.records.length} live source(s) [${result.forecast.records
      .map((record) => record.source)
      .join(", ")}], +${result.forecast.appended} new row(s)`,
  );

  if (!result.scoring.observation) {
    console.log(`[truth] ${result.scoring.date}: no observation available → skip scoring (no fabrication)`);
  } else {
    console.log(
      `[truth] ${result.scoring.date}: observed ${result.scoring.observation.observed_mm} mm (KMA ASOS, station 108)`,
    );
    if (result.scoring.priorForecasts === 0) {
      console.log(`[score] ${result.scoring.date}: no prior forecasts logged → skip (warm-up / missed run)`);
    } else {
      console.log(
        `[score] ${result.scoring.date}: scored ${result.scoring.records.length}/${result.scoring.priorForecasts} source(s), +${result.scoring.appended} new daily-skill row(s)`,
      );
      for (const record of result.scoring.records) {
        const quant = record.quantitative_skill === null ? "—" : record.quantitative_skill.toFixed(2);
        console.log(
          `  ${record.source.padEnd(14)} ${record.outcome.padEnd(16)} csi=${record.csi} skill=${record.skill.toFixed(3)} (cat=${record.categorical_skill} quant=${quant})`,
        );
      }
    }
  }

  console.log(
    `[weights] η=${eta} eventsScored=${result.weighting.state.eventsScored} processedDates=${result.weighting.state.processedDates.length} (+${result.weighting.newlyAppliedDates})`,
  );
  for (const [source, weight] of Object.entries(result.weighting.state.weights)) {
    console.log(`  ${source.padEnd(14)} ${weight.toFixed(4)}`);
  }
}

main().catch((error) => {
  console.error("[precip-reliability] fatal:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
