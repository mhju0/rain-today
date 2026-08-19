import type { HourlyForecast, WeatherCondition } from "../types.ts";

/**
 * Pure bucketing for the Forecast section's glanceable time-of-day strip. The
 * hourly series (already "now"-anchored — entries[0] is the current hour) is
 * folded into up to eight consecutive 3-hour windows — entries [0–2], [3–5],
 * … [21–23] — so the next ~24 hours read as eight wide blocks instead of a
 * 24-column scroll. Eight is what the providers actually reach: they cap the
 * series at 24 entries, so this consumes the series rather than truncating it.
 *
 * Everything here is Asia/Seoul and honours the "never fabricate" rule: a block
 * is built only when the data supports it (short series → fewer blocks, never an
 * invented one) and `precipMax` is `null` — not `0` — when no hour in the block
 * carries a probability.
 */

const KST = "Asia/Seoul";
const hourFmt = new Intl.DateTimeFormat("en-GB", { timeZone: KST, hour: "2-digit", hour12: false });
const dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: KST,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The KST wall-clock hour (0–23) for an ISO instant, via the format.ts pattern. */
function kstHour(iso: string): number {
  return Number(hourFmt.format(new Date(iso)));
}

/** The KST calendar date (YYYY-MM-DD) for an ISO instant. */
function kstDate(iso: string): string {
  return dateFmt.format(new Date(iso));
}

/**
 * Korean period name for a KST hour, by the documented bands:
 *   새벽 00–05 · 아침 06–08 · 오전 09–11 · 오후 12–17 · 저녁 18–20 · 밤 21–23
 * Exported for direct boundary testing.
 */
export function periodNameForHour(hour: number): string {
  if (hour <= 5) return "새벽";
  if (hour <= 8) return "아침";
  if (hour <= 11) return "오전";
  if (hour <= 17) return "오후";
  if (hour <= 20) return "저녁";
  return "밤";
}

export interface ForecastBlock {
  /** Block 0 → "지금"; later blocks → the Korean period name for the midpoint hour. */
  label: string;
  /** Short muted KST range, e.g. "15–18시" (end is exclusive — last hour + 1). */
  rangeLabel: string;
  /** KST wall-clock hour the block opens on. */
  startHour: number;
  /** Exclusive KST end hour — last hour + 1, wrapping to 0 past midnight. */
  endHour: number;
  /** KST calendar date (YYYY-MM-DD) the block opens on, for the date divider. */
  startDate: string;
  /** Max temperature across the block, rounded. */
  tempHigh: number;
  /** Min temperature across the block, rounded. */
  tempLow: number;
  /** Max non-null precipitation probability, or `null` when every hour is null. */
  precipMax: number | null;
  /** Representative condition for the day/night glyph (see selection rule below). */
  condition: WeatherCondition;
  /** ISO time of the block's midpoint entry (block 0: entries[0]) — for the glyph face. */
  representativeTime: string;
}

/** Build one block from its (1–3) entries. `index` drives the block-0 specials. */
function buildBlock(entries: HourlyForecast[], index: number): ForecastBlock {
  const temps = entries.map((e) => e.temperature);
  const tempHigh = Math.round(Math.max(...temps));
  const tempLow = Math.round(Math.min(...temps));

  const probs = entries
    .map((e) => e.precipitationProbability)
    .filter((p): p is number => p != null);
  const precipMax = probs.length > 0 ? Math.max(...probs) : null;

  // Block 0 anchors on its first (current) hour; later blocks on their midpoint.
  const midIdx = index === 0 ? 0 : Math.floor((entries.length - 1) / 2);
  const midEntry = entries[midIdx];

  // Representative condition: the hour with the single highest precip probability;
  // if no hour has a probability, or several tie for the max, fall back to the
  // midpoint hour's condition.
  let condition = midEntry.condition;
  if (precipMax != null) {
    const wettest = entries.filter((e) => e.precipitationProbability === precipMax);
    if (wettest.length === 1) condition = wettest[0].condition;
  }

  const label = index === 0 ? "지금" : periodNameForHour(kstHour(midEntry.time));

  const startHour = kstHour(entries[0].time);
  const endHour = (kstHour(entries[entries.length - 1].time) + 1) % 24;
  const rangeLabel = `${startHour}–${endHour}시`;

  return {
    label,
    rangeLabel,
    startHour,
    endHour,
    startDate: kstDate(entries[0].time),
    tempHigh,
    tempLow,
    precipMax,
    condition,
    representativeTime: midEntry.time,
  };
}

/**
 * Fold the hourly series into up to eight consecutive 3-hour blocks. Builds only
 * as many blocks as the data supports (a partial final window is kept; no block
 * is invented), so a short series simply yields fewer blocks.
 */
export function buildForecastBlocks(hourly: HourlyForecast[]): ForecastBlock[] {
  const blocks: ForecastBlock[] = [];
  for (let i = 0; i < 8; i++) {
    const entries = hourly.slice(i * 3, i * 3 + 3);
    if (entries.length === 0) break;
    blocks.push(buildBlock(entries, i));
  }
  return blocks;
}
