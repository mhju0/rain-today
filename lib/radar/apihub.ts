import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readResponseBytes } from "../httpResponse.ts";
import { cropToSeoul, CROP_W, encodePng, GRID_NX, GRID_NY } from "./grid.ts";
import { buildGeo, type GeoModel, reproject } from "./geo.ts";
import type { KmaRadarAdapter } from "./delivery.ts";
// Committed, bundler-inlined georeference model. A static JSON import is guaranteed to be
// traced into the serverless function (unlike a runtime read of the gitignored disk cache),
// so the steady-state path needs no latlon fetch at cold start. See buildOrReadGeo.
import bundledGeo from "./geo-HSR.json" with { type: "json" };

/**
 * SERVER-ONLY data layer for the high-resolution KMA radar (apihub.kma.go.kr).
 * The API key and the ~13 MB raw reflectivity grid NEVER reach the client — route
 * handlers receive only the small echo PNG through RadarDelivery.
 *
 *   • nph-rdr_cmp1_api  — one reflectivity frame (HSR, disp=B) for a given KST `tm`
 *   • nph-rdr_latlon_api — the per-cell lon/lat grids (fetched ONCE, cached to disk)
 *
 * SSRF: the host + path are constant and server-constructed; the only variable in a
 * frame request is `tm` (a 12-digit key validated upstream). The key is read from
 * `process.env.KMA_APIHUB_KEY` and is never logged or echoed in an error.
 */

const BASE = "https://apihub.kma.go.kr/api/typ01/cgi-bin/url/";
const GEO_FILE = "geo-HSR.json";
const FRAME_GRID_BYTES = 4 + GRID_NX * GRID_NY * 2;
const MAX_LATLON_BYTES = 100 * 1024 * 1024;
const RADAR_DATA_DIR = path.join(process.cwd(), "data", "radar");

function apiKey(): string {
  const v = process.env.KMA_APIHUB_KEY?.trim();
  if (!v) throw new Error("KMA_APIHUB_KEY not configured");
  return v;
}

/** Cheap presence check (no network) so the timeline can degrade before any fetch. */
export function hasApiKey(): boolean {
  return !!process.env.KMA_APIHUB_KEY?.trim();
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function fetchLatLon(which: "lon" | "lat"): Promise<string> {
  const url = `${BASE}nph-rdr_latlon_api?${new URLSearchParams({
    cmp: "HSR",
    latlon: which,
    authKey: apiKey(),
  })}`;
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`KMA latlon HTTP ${res.status}`);
  const text = new TextDecoder().decode(await readResponseBytes(res, { maxBytes: MAX_LATLON_BYTES }));
  // Expect the `  nx,  ny,=` header; reject an error/HTML body before parsing 70 MB.
  if (!/^\s*\d+\s*,\s*\d+\s*,/.test(text)) throw new Error("KMA latlon: unexpected payload");
  return text;
}

let geoMemo: Promise<GeoModel> | null = null;

/** Shape-check a candidate model: has the affine fit and matches the current crop window.
 *  The CROP_W guard makes a stale bundle/disk cache self-invalidate if the crop changes. */
function isUsableGeo(g: unknown): g is GeoModel {
  const c = g as GeoModel | null;
  return !!(c?.inv && c?.bbox && c.crop?.w === CROP_W);
}

async function buildOrReadGeo(): Promise<GeoModel> {
  // 1) Bundled model — inlined by the bundler, so it ships inside the function. The HSR grid
  //    geometry is fixed, so this is the steady state and skips the cold-start latlon fetch.
  if (isUsableGeo(bundledGeo)) return bundledGeo;

  // 2) Fallback boundary — only reached if the bundled model is missing/stale (e.g. a crop
  //    change): the original disk cache, else a one-time rebuild from the latlon API.
  const file = path.join(RADAR_DATA_DIR, GEO_FILE);
  try {
    const cached = JSON.parse(await readFile(file, "utf8")) as GeoModel;
    if (isUsableGeo(cached)) return cached;
  } catch {
    // Not cached yet (or unreadable) → build it from the latlon API once.
  }
  const [lonText, latText] = await Promise.all([fetchLatLon("lon"), fetchLatLon("lat")]);
  const geo = buildGeo(lonText, latText);
  try {
    await mkdir(RADAR_DATA_DIR, { recursive: true });
    await writeFile(file, JSON.stringify(geo, null, 2), "utf8");
  } catch {
    // Disk cache is an optimisation; the in-memory model is enough to serve.
  }
  return geo;
}

/** The georeferencing model (memoised in-process, disk-cached). Built once. */
export async function loadGeo(): Promise<GeoModel> {
  if (!geoMemo) {
    geoMemo = buildOrReadGeo().catch((err) => {
      geoMemo = null; // allow a later retry (e.g. transient latlon fetch failure)
      throw err;
    });
  }
  return geoMemo;
}

/** Lat/lon extent of the rendered echo raster — the client georeferences the PNG to this. */
export async function frameBounds(signal?: AbortSignal): Promise<GeoModel["bbox"]> {
  return (await waitForSignal(loadGeo(), signal)).bbox;
}

async function fetchFrameGrid(tm: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const url = `${BASE}nph-rdr_cmp1_api?${new URLSearchParams({
    tm,
    cmp: "HSR",
    qcd: "MSK",
    obs: "ECHO",
    map: "HB",
    disp: "B",
    authKey: apiKey(),
  })}`;
  const res = await fetch(url, { redirect: "error", signal: requestSignal(signal, 25_000) });
  if (!res.ok) throw new Error(`KMA radar HTTP ${res.status}`);
  const bytes = await readResponseBytes(res, { maxBytes: FRAME_GRID_BYTES });
  if (bytes.byteLength !== FRAME_GRID_BYTES) throw new Error("KMA radar: unexpected payload length");
  return bytes.buffer as ArrayBuffer;
}

/**
 * Render one frame's Seoul echo to a Mercator-aligned PNG (transparent where no echo).
 * This production adapter deliberately owns no caching or admission; RadarDelivery owns
 * those policies. Throws if the key is missing, the frame is unavailable, or malformed.
 */
async function renderKmaFrame(tm: string, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const [buf, geo] = await Promise.all([
    fetchFrameGrid(tm, signal),
    waitForSignal(loadGeo(), signal),
  ]);
  signal?.throwIfAborted();
  const crop = cropToSeoul(buf); // validates disp=B header + length
  const { rgba, width, height } = reproject(crop, geo);
  signal?.throwIfAborted();
  return encodePng(rgba, width, height);
}

export const productionKmaRadarAdapter: KmaRadarAdapter = {
  configured: hasApiKey,
  bounds: frameBounds,
  render: renderKmaFrame,
};

/** Compatibility for the frame route until it migrates to RadarDelivery in Task 2. */
export async function renderFrame(tm: string, signal?: AbortSignal): Promise<Buffer> {
  const { productionRadarDelivery } = await import("./delivery.ts");
  const result = await productionRadarDelivery.frame(tm, signal);
  if (result.kind === "ready") return result.png;
  throw new Error(`radar ${result.kind}`);
}
