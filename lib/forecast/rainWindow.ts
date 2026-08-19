import type { ForecastBlock } from "./blocks.ts";

/**
 * Pure reading of the folded 3-hour blocks, for the one sentence the page leads
 * with: when the rain starts and when it stops.
 *
 * Everything here is derived, never invented. A block with no published
 * probability is not wet and is not dry — it ends a run rather than extending
 * one, and it can leave the run's end unknown. `endsWithinWindow` says whether
 * the published series actually saw the rain stop, so the sentence can say
 * "9시까지" only when a later block proved it.
 */

export interface RainWindowRun {
  /** Index of the first wet block in the run. */
  startIndex: number;
  /** Index of the last wet block in the run. */
  endIndex: number;
  /** KST hour the run opens on. */
  startHour: number;
  /** Exclusive KST hour the run closes on — only meaningful when it ends within the window. */
  endHour: number;
  /** Korean period name for the opening block ("새벽", "아침", …; "지금" for block 0). */
  startLabel: string;
  /** The run opens on a later KST date than the series does. */
  startsTomorrow: boolean;
  /** Hours covered by the run's blocks. */
  durationHours: number;
  /**
   * A later block showed the rain stopping. False when the run runs off the end
   * of the published series, where the end time is simply not known.
   */
  endsWithinWindow: boolean;
  /** Highest probability inside this run. */
  peakProbability: number;
}

export interface TimelineReading {
  /** The first wet run, which is what the headline sentence describes. */
  firstRun: RainWindowRun | null;
  /**
   * A second, separate wet run inside the same window. Held apart from
   * `firstRun` so the page can mention it instead of silently implying that the
   * rain stops for good.
   */
  laterRun: RainWindowRun | null;
  /** Highest probability anywhere in the window, and the block that carries it. */
  peak: { probability: number; rangeLabel: string; startsTomorrow: boolean } | null;
}

/** Hours a block covers. A trailing partial block is shorter than three. */
function blockHours(block: ForecastBlock): number {
  const span = (block.endHour - block.startHour + 24) % 24;
  return span === 0 ? 24 : span;
}

function buildRun(blocks: ForecastBlock[], startIndex: number, endIndex: number): RainWindowRun {
  const run = blocks.slice(startIndex, endIndex + 1);
  return {
    startIndex,
    endIndex,
    startHour: blocks[startIndex].startHour,
    endHour: blocks[endIndex].endHour,
    startLabel: blocks[startIndex].label,
    startsTomorrow: blocks[startIndex].startDate !== blocks[0].startDate,
    durationHours: run.reduce((total, block) => total + blockHours(block), 0),
    endsWithinWindow: endIndex < blocks.length - 1,
    peakProbability: Math.max(...run.map((block) => block.precipMax ?? 0)),
  };
}

/**
 * Read the blocks against `threshold` — the probability at or above which this
 * page is willing to call a block wet.
 */
export function readTimeline(blocks: ForecastBlock[], threshold: number): TimelineReading {
  const wet = blocks.map(
    (block) => block.precipMax !== null && block.precipMax >= threshold,
  );

  const runs: RainWindowRun[] = [];
  let openedAt: number | null = null;
  for (let i = 0; i < blocks.length; i++) {
    if (wet[i] && openedAt === null) openedAt = i;
    if (!wet[i] && openedAt !== null) {
      runs.push(buildRun(blocks, openedAt, i - 1));
      openedAt = null;
    }
  }
  if (openedAt !== null) runs.push(buildRun(blocks, openedAt, blocks.length - 1));

  let peak: TimelineReading["peak"] = null;
  for (const block of blocks) {
    if (block.precipMax === null) continue;
    if (peak === null || block.precipMax > peak.probability) {
      peak = {
        probability: block.precipMax,
        rangeLabel: block.rangeLabel,
        startsTomorrow: block.startDate !== blocks[0].startDate,
      };
    }
  }

  return { firstRun: runs[0] ?? null, laterRun: runs[1] ?? null, peak };
}
