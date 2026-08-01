import type { RadarBounds } from "../types.ts";

export const RADAR_FRAME_STEP_MINUTES = 5;
export const RADAR_MAX_FRAME_AGE_MINUTES = 90;
const RADAR_PUBLISH_LAG_MINUTES = 7;

export const KMA_RADAR_ATTRIBUTION = "기상청 (KMA)";

export interface KmaRadarAdapter {
  configured(): boolean;
  bounds(signal?: AbortSignal): Promise<RadarBounds>;
  render(key: string, signal?: AbortSignal): Promise<Buffer>;
}

export type KmaRadarSourceFailureKind = "not-yet-published" | "terminal";

/** Sanitized adapter failure used by RadarDelivery to decide whether fallback is safe. */
export class KmaRadarSourceError extends Error {
  readonly kind: KmaRadarSourceFailureKind;

  constructor(kind: KmaRadarSourceFailureKind) {
    super("KMA radar source unavailable");
    this.name = "KmaRadarSourceError";
    this.kind = kind;
  }
}

/** Only an explicitly absent frame is safe to interpret as publication lag. */
export function classifyKmaRadarResponseStatus(status: number): KmaRadarSourceFailureKind {
  return status === 204 || status === 404 ? "not-yet-published" : "terminal";
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The latest five-minute boundary at or before the KMA publication lag, KST-shifted. */
export function latestFrameInstant(nowMs = Date.now()): Date {
  const stepMs = RADAR_FRAME_STEP_MINUTES * 60_000;
  const kstMs = nowMs + 9 * 3600_000 - RADAR_PUBLISH_LAG_MINUTES * 60_000;
  return new Date(Math.floor(kstMs / stepMs) * stepMs);
}

/** yyyyMMddHHmm (KST) key for a KST-shifted Date. */
export function frameKey(kst: Date): string {
  return (
    `${kst.getUTCFullYear()}${pad(kst.getUTCMonth() + 1)}${pad(kst.getUTCDate())}` +
    `${pad(kst.getUTCHours())}${pad(kst.getUTCMinutes())}`
  );
}

/** True ISO instant (UTC) for a KST yyyyMMddHHmm key. */
export function frameKeyToIso(key: string): string {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(4, 6)) - 1;
  const day = Number(key.slice(6, 8));
  const hour = Number(key.slice(8, 10));
  const minute = Number(key.slice(10, 12));
  return new Date(Date.UTC(year, month, day, hour, minute) - 9 * 3600_000).toISOString();
}

/** A real calendar instant aligned to the KMA five-minute frame cadence. */
export function isValidFrameKey(key: string): boolean {
  if (!/^\d{12}$/.test(key)) return false;
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(4, 6));
  const day = Number(key.slice(6, 8));
  const hour = Number(key.slice(8, 10));
  const minute = Number(key.slice(10, 12));
  if (minute % RADAR_FRAME_STEP_MINUTES !== 0) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour &&
    parsed.getUTCMinutes() === minute
  );
}

/** Restrict expensive KMA work to the recent observed playback window. */
export function isAllowedFrameKey(key: string, nowMs = Date.now()): boolean {
  if (!isValidFrameKey(key)) return false;
  const frameMs = Date.UTC(
    Number(key.slice(0, 4)),
    Number(key.slice(4, 6)) - 1,
    Number(key.slice(6, 8)),
    Number(key.slice(8, 10)),
    Number(key.slice(10, 12)),
  );
  const newestMs = latestFrameInstant(nowMs).getTime();
  return (
    frameMs <= newestMs &&
    frameMs >= newestMs - RADAR_MAX_FRAME_AGE_MINUTES * 60_000
  );
}
