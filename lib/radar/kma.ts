import type { KmaRadarFrames } from "../types.ts";
import {
  frameKey,
  frameKeyToIso,
  isAllowedFrameKey,
  isValidFrameKey,
  KMA_RADAR_ATTRIBUTION,
  latestFrameInstant,
  productionRadarDelivery,
} from "./delivery.ts";

/**
 * Compatibility exports for the pure KST key helpers. RadarDelivery owns their use for
 * validation and timeline construction; existing callers migrate to that interface in
 * the next task.
 */
export {
  frameKey,
  frameKeyToIso,
  isAllowedFrameKey,
  isValidFrameKey,
  KMA_RADAR_ATTRIBUTION,
  latestFrameInstant,
};

/** Compatibility for the timeline route until it migrates to RadarDelivery in Task 2. */
export async function recentRadarFrames(signal?: AbortSignal): Promise<KmaRadarFrames> {
  return productionRadarDelivery.timeline(signal);
}
