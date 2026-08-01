import type { KmaRadarFrame, RadarBounds, SkyRadar } from "../types.ts";
import { BASEMAP, CITY_LABELS } from "./config.ts";
import { latToWorldY, lonToWorldX } from "./mercator.ts";

const KST_FRAME_TIME = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** User-facing radar copy derived only from facts in the approach signal. */
export function radarApproachSummary(radar: SkyRadar | null | undefined): string {
  if (!radar) return "레이더 관측 없음";
  if (radar.approaching && radar.fromDirection) {
    return `${radar.fromDirection}쪽에서 비구름 접근 중`;
  }
  if (radar.precipNearby) return "서울 부근에 강수 관측";
  return "접근하는 비구름 없음";
}

/** Minutes of `frame` relative to the latest observed instant. */
export function radarFrameOffsetMinutes(
  frame: Pick<KmaRadarFrame, "time">,
  latestObservedMs: number,
): number | null {
  const frameMs = Date.parse(frame.time);
  if (!Number.isFinite(frameMs) || !Number.isFinite(latestObservedMs)) return null;
  return Math.round((frameMs - latestObservedMs) / 60_000);
}

/** Honest tag for an observed frame; KMA composite frames are not nowcasts. */
export function radarFrameTag(
  frame: Pick<KmaRadarFrame, "time">,
  latestObservedMs: number,
): string {
  const offset = radarFrameOffsetMinutes(frame, latestObservedMs);
  if (offset === null) return "관측 시간 확인 불가";
  if (offset === 0) return "실시간 · 관측";
  return `${offset}분 · 관측`;
}

/** KST clock label that degrades without throwing on malformed upstream time. */
export function formatRadarFrameTime(time: string): string {
  const instant = new Date(time);
  if (!Number.isFinite(instant.getTime())) return "--:--";
  return KST_FRAME_TIME.format(instant);
}

export interface RadarTimelineState {
  activeIndex: number;
  latestIndex: number;
  latestObservedMs: number | null;
}

/**
 * Keep a local playhead valid when a refreshed response has fewer frames. Empty
 * and malformed timelines resolve without exposing an invalid array index.
 */
export function resolveRadarTimeline(
  frames: readonly Pick<KmaRadarFrame, "time">[],
  requestedIndex: number,
): RadarTimelineState {
  if (frames.length === 0) {
    return { activeIndex: 0, latestIndex: 0, latestObservedMs: null };
  }

  const latestIndex = frames.length - 1;
  const finiteIndex = Number.isFinite(requestedIndex) ? Math.trunc(requestedIndex) : latestIndex;
  const activeIndex = Math.max(0, Math.min(finiteIndex, latestIndex));
  const parsedLatest = Date.parse(frames[latestIndex].time);

  return {
    activeIndex,
    latestIndex,
    latestObservedMs: Number.isFinite(parsedLatest) ? parsedLatest : null,
  };
}

/** Advance observed-frame playback, looping safely to the oldest frame. */
export function advanceRadarFrame(currentIndex: number, frameCount: number): number {
  if (!Number.isInteger(frameCount) || frameCount <= 1) return 0;
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= frameCount) return 0;
  return currentIndex + 1 >= frameCount ? 0 : currentIndex + 1;
}

/** Prioritize the active frame, then warm each later playback frame exactly once. */
export function orderedRadarWarmup(
  frames: readonly KmaRadarFrame[],
  activeIndex: number,
): KmaRadarFrame[] {
  if (frames.length === 0) return [];
  const start = Math.max(
    0,
    Math.min(Number.isFinite(activeIndex) ? Math.trunc(activeIndex) : 0, frames.length - 1),
  );
  return [...frames.slice(start), ...frames.slice(0, start)];
}

export interface RadarMosaic {
  /** Bounding-box size in world pixels, used for the cover-fit aspect ratio. */
  wpW: number;
  wpH: number;
  wider: boolean;
  tiles: { x: number; y: number; url: string; left: number; top: number; w: number; h: number }[];
  labels: { ko: string; left: number; top: number }[];
}

export const RADAR_BASEMAP_ATTRIBUTION = BASEMAP.attribution;

function basemapTileUrl(x: number, y: number): string {
  const subdomain = BASEMAP.subdomains[Math.abs(x + y) % BASEMAP.subdomains.length];
  return BASEMAP.urlTemplate
    .replace("{s}", subdomain)
    .replace("{z}", String(BASEMAP.zoom))
    .replace("{x}", String(x))
    .replace("{y}", String(y))
    .replace("{r}", "@2x");
}

/**
 * Lay out the basemap tiles and Korean labels in the same Web-Mercator bounding
 * box as the KMA echo. Components receive ready-to-render percentages and never
 * need to know projection or tile-provider rules.
 */
export function buildRadarMosaic(bounds: RadarBounds): RadarMosaic {
  const zoom = BASEMAP.zoom;
  const x0 = lonToWorldX(bounds.west, zoom);
  const x1 = lonToWorldX(bounds.east, zoom);
  const y0 = latToWorldY(bounds.north, zoom);
  const y1 = latToWorldY(bounds.south, zoom);
  const wpW = x1 - x0;
  const wpH = y1 - y0;
  const place = (lat: number, lon: number) => ({
    left: ((lonToWorldX(lon, zoom) - x0) / wpW) * 100,
    top: ((latToWorldY(lat, zoom) - y0) / wpH) * 100,
  });

  const tiles: RadarMosaic["tiles"] = [];
  for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x1 - 1e-6) / 256); tx++) {
    for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y1 - 1e-6) / 256); ty++) {
      tiles.push({
        x: tx,
        y: ty,
        url: basemapTileUrl(tx, ty),
        left: ((tx * 256 - x0) / wpW) * 100,
        top: ((ty * 256 - y0) / wpH) * 100,
        w: (256 / wpW) * 100,
        h: (256 / wpH) * 100,
      });
    }
  }

  return {
    wpW,
    wpH,
    wider: wpW >= wpH,
    tiles,
    labels: CITY_LABELS.map((city) => ({ ko: city.ko, ...place(city.lat, city.lon) })),
  };
}
