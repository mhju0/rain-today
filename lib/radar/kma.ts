import type { KmaRadarFrame, KmaRadarFrames, RadarBounds } from "../types.ts";
import { frameBounds, hasApiKey, renderFrame } from "./apihub.ts";

/**
 * KMA radar timeline (기상청 레이더) — the SERVER-ONLY source behind the /sky radar scope.
 * The imagery is the high-resolution HSR reflectivity grid from apihub.kma.go.kr,
 * cropped to Seoul and rendered to a small echo PNG server-side (see apihub.ts + grid.ts
 * + geo.ts). The API key and the ~13 MB raw grid never reach the client.
 *
 * This module owns the frame TIMELINE: pure KST 5-minute bucketing math + a single
 * cached liveness probe of the newest frame (which also warms its render). Everything
 * degrades to `available:false` (never throws to the route) when the key is missing or
 * the source is unreachable, so the section shows an honest empty state.
 *
 * The keyless RainViewer approach signal that feeds the headline (lib/providers/radar.ts)
 * is entirely independent of this module.
 */

const FRAME_STEP_MIN = 5; // grid cadence
const FRAME_COUNT = 13; // ~1h of observed frames (each disp=B frame is ~13 MB upstream)
const PUBLISH_LAG_MIN = 7; // newest frame publishes ~5–10 min late; bucket to (now − 7min)
const MAX_FRAME_AGE_MIN = 90; // one-hour timeline + playback/network grace

export const KMA_RADAR_ATTRIBUTION = "기상청 (KMA)";

const EMPTY: KmaRadarFrames = {
  available: false,
  frames: [],
  attribution: KMA_RADAR_ATTRIBUTION,
  bounds: null,
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The most-recent 5-min boundary at/just-before (now − publish lag), as a KST-shifted
 *  Date (read its components with getUTC*). */
export function latestFrameInstant(nowMs = Date.now()): Date {
  const stepMs = FRAME_STEP_MIN * 60_000;
  const kstMs = nowMs + 9 * 3600_000 - PUBLISH_LAG_MIN * 60_000;
  return new Date(Math.floor(kstMs / stepMs) * stepMs);
}

/** yyyyMMddHHmm (KST) key for a KST-shifted Date — the `tm` param + proxy `t`. */
export function frameKey(kst: Date): string {
  return (
    `${kst.getUTCFullYear()}${pad(kst.getUTCMonth() + 1)}${pad(kst.getUTCDate())}` +
    `${pad(kst.getUTCHours())}${pad(kst.getUTCMinutes())}`
  );
}

/** True ISO instant (UTC) for a KST yyyyMMddHHmm key — drives KST display formatting. */
export function frameKeyToIso(t: string): string {
  const y = +t.slice(0, 4);
  const mo = +t.slice(4, 6) - 1;
  const da = +t.slice(6, 8);
  const h = +t.slice(8, 10);
  const mi = +t.slice(10, 12);
  return new Date(Date.UTC(y, mo, da, h, mi) - 9 * 3600_000).toISOString();
}

/** A real calendar instant aligned to the KMA five-minute frame cadence. */
export function isValidFrameKey(t: string): boolean {
  if (!/^\d{12}$/.test(t)) return false;
  const y = Number(t.slice(0, 4));
  const mo = Number(t.slice(4, 6));
  const d = Number(t.slice(6, 8));
  const h = Number(t.slice(8, 10));
  const min = Number(t.slice(10, 12));
  if (min % FRAME_STEP_MIN !== 0) return false;
  const parsed = new Date(Date.UTC(y, mo - 1, d, h, min));
  return (
    parsed.getUTCFullYear() === y &&
    parsed.getUTCMonth() === mo - 1 &&
    parsed.getUTCDate() === d &&
    parsed.getUTCHours() === h &&
    parsed.getUTCMinutes() === min
  );
}

/** Restrict the expensive public renderer to the current observed playback window. */
export function isAllowedFrameKey(t: string, nowMs = Date.now()): boolean {
  if (!isValidFrameKey(t)) return false;
  const frameMs = Date.UTC(
    Number(t.slice(0, 4)),
    Number(t.slice(4, 6)) - 1,
    Number(t.slice(6, 8)),
    Number(t.slice(8, 10)),
    Number(t.slice(10, 12)),
  );
  const newestMs = latestFrameInstant(nowMs).getTime();
  return frameMs <= newestMs && frameMs >= newestMs - MAX_FRAME_AGE_MIN * 60_000;
}

/**
 * The recent observed frame list (oldest → newest), for the timeline, plus the geo
 * bounds the client georeferences the echo to. Pure time math except a single cached
 * probe-render of the newest frame, so we never list a frame the source can't deliver:
 * if it fails (no key / source down / not yet published) we report `available:false`.
 */
export async function recentRadarFrames(): Promise<KmaRadarFrames> {
  if (!hasApiKey()) return EMPTY;
  const newest = latestFrameInstant();
  let bounds: RadarBounds;
  try {
    await renderFrame(frameKey(newest)); // confirm live + warm the newest render
    bounds = await frameBounds();
  } catch {
    return EMPTY;
  }
  const frames: KmaRadarFrame[] = [];
  for (let i = FRAME_COUNT - 1; i >= 0; i--) {
    const d = new Date(newest.getTime() - i * FRAME_STEP_MIN * 60_000);
    const t = frameKey(d);
    frames.push({ t, time: frameKeyToIso(t), nowcast: false });
  }
  return { available: true, frames, attribution: KMA_RADAR_ATTRIBUTION, bounds };
}
