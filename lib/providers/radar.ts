import { inflateSync } from "node:zlib";
import { cachedFetch } from "../cache.ts";
import { readResponseBytes } from "../httpResponse.ts";
import {
  DEFAULT_FORECAST_LOCATION,
  forecastLocationCacheKey,
  type ForecastLocation,
} from "../location.ts";
import type {
  NormalizedRadarFrame,
  RadarSummary,
  SkyRadar,
  WeatherProviderStatus,
} from "../types";

/**
 * RainViewer radar — OPTIONAL and terms-aware. Free public API
 * (https://www.rainviewer.com/api.html); attribution is required wherever radar
 * imagery is displayed. We use it only for OBSERVED recent precipitation
 * movement — never as a forecast. Everything degrades to "unavailable" silently
 * so the public scene never depends on it.
 *
 * Cinematic use is restrained and HONEST: we fetch the two most recent observed
 * frames for the single zoom-6 tile that covers Seoul, decode them (they are
 * 8-bit RGBA PNGs, so a tiny zlib-based reader suffices — no image deps), and
 * sample precipitation coverage to the west of / near Seoul. A "rain approaching
 * from the west" signal is emitted only when the pixels actually support it.
 *
 * ⚠ Terms: free for limited/non-commercial use; review RainViewer's current
 * terms before any commercial deployment, and keep the visible attribution.
 */

const MAPS_URL = "https://api.rainviewer.com/public/weather-maps.json";
const ATTRIBUTION = "RainViewer";
const RADAR_TTL_MS = 10 * 60 * 1000;
const ZOOM = 6;
const TILE_SIZE = 256;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_TILE_BYTES = 1024 * 1024;

// ─── minimal PNG decode (8-bit RGBA, non-interlaced — RainViewer's tile format) ─

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodeRainViewerPng(buf: Buffer): { width: number; height: number; rgba: Uint8Array } | null {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) break;
    if (type === "IHDR" && len === 13) {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      if (buf[dataStart + 10] !== 0 || buf[dataStart + 11] !== 0 || buf[dataStart + 12] !== 0) {
        return null;
      }
    } else if (type === "IDAT") {
      idat.push(buf.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    off = dataEnd + 4; // skip CRC
  }
  if (colorType !== 6 || bitDepth !== 8 || width !== TILE_SIZE || height !== TILE_SIZE) return null;
  const stride = width * 4;
  const expectedRawBytes = (stride + 1) * height;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expectedRawBytes });
  } catch {
    return null;
  }
  if (raw.length !== expectedRawBytes) return null;
  const rgba = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    for (let x = 0; x < stride; x++) {
      const rb = raw[pos++];
      const a = x >= 4 ? cur[x - 4] : 0;
      const b = prev[x];
      const c = x >= 4 ? prev[x - 4] : 0;
      let v: number;
      switch (filter) {
        case 1: v = rb + a; break;
        case 2: v = rb + b; break;
        case 3: v = rb + ((a + b) >> 1); break;
        case 4: v = rb + paeth(a, b, c); break;
        case 0: v = rb; break;
        default: return null;
      }
      cur[x] = v & 0xff;
    }
    rgba.set(cur, y * stride);
    prev.set(cur);
  }
  return { width, height, rgba };
}

export function normalizeRainViewerHost(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "tilecache.rainviewer.com" ||
      (url.port !== "" && url.port !== "443") ||
      url.username !== "" ||
      url.password !== "" ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function validateRainViewerPath(value: string): boolean {
  return /^\/v2\/radar\/[A-Za-z0-9_/-]+$/.test(value) && !value.includes("//");
}

// ─── tile math + sampling ────────────────────────────────────────────────────

function locationTile(
  location: ForecastLocation,
  z: number,
): { x: number; y: number; px: number; py: number } {
  const n = 2 ** z;
  const xf = ((location.longitude + 180) / 360) * n;
  const latRad = (location.latitude * Math.PI) / 180;
  const yf = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const x = Math.floor(xf);
  const y = Math.floor(yf);
  return { x, y, px: Math.round((xf - x) * 256), py: Math.round((yf - y) * 256) };
}

/** Fraction of pixels with meaningful precipitation alpha in a box. */
function coverage(
  img: { width: number; height: number; rgba: Uint8Array },
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): number {
  const xa = Math.max(0, Math.min(img.width, x0));
  const xb = Math.max(0, Math.min(img.width, x1));
  const ya = Math.max(0, Math.min(img.height, y0));
  const yb = Math.max(0, Math.min(img.height, y1));
  let hit = 0;
  let total = 0;
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      total++;
      if (img.rgba[(y * img.width + x) * 4 + 3] > 20) hit++;
    }
  }
  return total === 0 ? 0 : hit / total;
}

async function fetchTile(
  location: ForecastLocation,
  host: string,
  path: string,
): Promise<Buffer | null> {
  const { x, y } = locationTile(location, ZOOM);
  try {
    const url = new URL(`${path}/256/${ZOOM}/${x}/${y}/2/1_1.png`, host);
    if (url.origin !== host) return null;
    const res = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return Buffer.from(
      await readResponseBytes(res, { maxBytes: MAX_TILE_BYTES, contentType: "image/png" }),
    );
  } catch {
    return null;
  }
}

interface Approach {
  precipNearby: boolean;
  approaching: boolean | null;
  fromDirection: SkyRadar["fromDirection"];
}

/**
 * Conservative west→east approach detection. Korea's synoptic flow is mostly
 * westerly, so precip sitting to the WEST of Seoul while Seoul itself is still
 * mostly clear, persisting across two frames, reads as "approaching from the
 * west". Anything ambiguous returns approaching:false (no directional claim).
 */
async function analyzeApproach(
  location: ForecastLocation,
  host: string,
  paths: string[],
): Promise<Approach> {
  const none: Approach = { precipNearby: false, approaching: null, fromDirection: null };
  const recent = paths.slice(-2); // [prev, latest]
  if (recent.length === 0) return none;

  const tiles = await Promise.all(recent.map((p) => fetchTile(location, host, p)));
  const imgs = tiles.map((b) => (b ? decodeRainViewerPng(b) : null));
  const latest = imgs.at(-1);
  if (!latest) return none;
  const prev = imgs.length > 1 ? imgs[0] : null;

  const { px, py } = locationTile(location, ZOOM);
  const yTop = py - 55;
  const yBot = py + 55;

  const near = coverage(latest, px - 16, px + 16, py - 20, py + 20);
  const west = coverage(latest, px - 100, px - 24, yTop, yBot);
  const east = coverage(latest, px + 24, px + 100, yTop, yBot);
  const westPrev = prev ? coverage(prev, px - 100, px - 24, yTop, yBot) : west;

  const precipNearby = near > 0.02;

  // Approaching: real precip to the west, not yet dominant at Seoul, biased west,
  // and present in the previous frame too (so it isn't single-frame noise).
  const approaching =
    west > 0.05 && near < 0.25 && west >= east * 1.2 && westPrev > 0.02;

  let fromDirection: SkyRadar["fromDirection"] = null;
  if (approaching) {
    const nw = coverage(latest, px - 100, px - 24, yTop, py - 18);
    const mw = coverage(latest, px - 100, px - 24, py - 18, py + 18);
    const sw = coverage(latest, px - 100, px - 24, py + 18, yBot);
    fromDirection = nw > mw && nw > sw ? "북서" : sw > mw && sw > nw ? "남서" : "서";
  }

  return { precipNearby, approaching, fromDirection };
}

// ─── fetch + summarize ───────────────────────────────────────────────────────

async function fetchRadar(location: ForecastLocation): Promise<RadarSummary> {
  const res = await fetch(MAPS_URL, {
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`RainViewer HTTP ${res.status}`);
  const bytes = await readResponseBytes(res, {
    maxBytes: MAX_METADATA_BYTES,
    contentType: "application/json",
  });
  const data = JSON.parse(new TextDecoder().decode(bytes)) as {
    host: string;
    radar?: { past?: { time: number; path: string }[]; nowcast?: { time: number; path: string }[] };
  };
  const host = normalizeRainViewerHost(data.host);
  if (!host) throw new Error("RainViewer returned an untrusted tile host");
  const past = (data.radar?.past ?? []).filter((frame) => validateRainViewerPath(frame.path));
  const nowcast = (data.radar?.nowcast ?? []).filter((frame) => validateRainViewerPath(frame.path));
  const frames: NormalizedRadarFrame[] = [
    ...past.map((f) => ({ time: new Date(f.time * 1000).toISOString(), path: f.path, nowcast: false })),
    ...nowcast.map((f) => ({ time: new Date(f.time * 1000).toISOString(), path: f.path, nowcast: true })),
  ];
  const latestObservedAt = past.length ? new Date(past[past.length - 1].time * 1000).toISOString() : null;

  const approach = past.length
    ? await analyzeApproach(location, host, past.map((f) => f.path))
    : { precipNearby: false, approaching: null as boolean | null, fromDirection: null };

  return {
    available: past.length > 0,
    frames,
    latestObservedAt,
    host,
    attribution: ATTRIBUTION,
    precipNearby: approach.precipNearby,
    approaching: approach.approaching,
    fromDirection: approach.fromDirection,
    stale: false,
  };
}

const radarCached = (location: ForecastLocation) =>
  cachedFetch(
    `rainviewer-radar:${forecastLocationCacheKey(location)}`,
    RADAR_TTL_MS,
    () => fetchRadar(location),
  );

/** Full radar summary for /diagnostics + the radar route. Never throws. */
export async function getRadarSummary(
  location: ForecastLocation = DEFAULT_FORECAST_LOCATION,
): Promise<RadarSummary | null> {
  try {
    const r = await radarCached(location);
    return { ...r.value, stale: r.stale };
  } catch {
    return null;
  }
}

/** Lean radar bits for the cinematic scene (/api/sky). Never throws. */
export async function getSkyRadar(
  location: ForecastLocation = DEFAULT_FORECAST_LOCATION,
): Promise<SkyRadar | null> {
  const s = await getRadarSummary(location);
  if (!s || !s.available) return null;
  return {
    precipNearby: s.precipNearby,
    approaching: s.approaching,
    fromDirection: s.fromDirection,
  };
}

/** Status row for /diagnostics. */
export async function radarStatus(
  location: ForecastLocation = DEFAULT_FORECAST_LOCATION,
): Promise<WeatherProviderStatus> {
  const s = await getRadarSummary(location);
  if (!s) {
    return {
      id: "rainviewer",
      name: "RainViewer 레이더",
      availability: "error",
      message: "레이더 메타데이터를 불러오지 못했습니다",
      missingEnvVars: [],
      lastUpdated: null,
      fromCache: false,
    };
  }
  return {
    id: "rainviewer",
    name: "RainViewer 레이더",
    availability: s.available ? "ok" : "unavailable",
    message: s.available
      ? `최근 관측 프레임 ${s.frames.filter((f) => !f.nowcast).length}개 · 출처 ${s.attribution}`
      : "사용 가능한 레이더 프레임이 없습니다",
    missingEnvVars: [],
    lastUpdated: s.latestObservedAt,
    fromCache: false,
    stale: s.stale,
  };
}
