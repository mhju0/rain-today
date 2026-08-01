import type { WeightsMap, WeightsState } from "./types.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EXPLICIT_OFFSET_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const NORMALIZED_EPSILON = 1e-6;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Require a real ISO calendar instant with `Z` or an explicit numeric offset. */
export function isExplicitOffsetIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = EXPLICIT_OFFSET_INSTANT_RE.exec(value);
  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
  ].map(Number);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }

  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour ||
    calendar.getUTCMinutes() !== minute ||
    calendar.getUTCSeconds() !== second
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Validate untrusted persisted/runtime weight JSON and return a clean value.
 * Invalid state is deliberately represented as null so request handling can use
 * the equal-weight fallback without allowing NaN, negative, or unnormalized
 * values into the fusion math.
 */
export function parseWeightsState(value: unknown): WeightsState | null {
  if (!isObject(value) || !isExplicitOffsetIsoInstant(value.updatedAt)) return null;
  if (!Number.isInteger(value.eventsScored) || (value.eventsScored as number) < 0) return null;
  if (!Array.isArray(value.processedDates) || !value.processedDates.every(isCalendarDate)) return null;

  const processedDates = value.processedDates as string[];
  if (new Set(processedDates).size !== processedDates.length) return null;
  if (!isObject(value.weights)) return null;

  const entries = Object.entries(value.weights);
  if (entries.length === 0) return null;

  const weights: WeightsMap = {};
  let total = 0;
  for (const [source, weight] of entries) {
    if (!SOURCE_RE.test(source) || typeof weight !== "number" || !Number.isFinite(weight)) return null;
    if (weight < 0 || weight > 1) return null;
    weights[source] = weight;
    total += weight;
  }
  if (Math.abs(total - 1) > NORMALIZED_EPSILON) return null;

  return {
    updatedAt: value.updatedAt,
    eventsScored: value.eventsScored as number,
    processedDates: [...processedDates],
    weights,
  };
}
