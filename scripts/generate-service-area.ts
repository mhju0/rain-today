/**
 * Generate the server-only Korea service-area containment asset.
 *
 * Reads the official SGIS 시도 boundary shapefile, simplifies each ring in the
 * source projection, reprojects to WGS84, and writes a checksummed encoded
 * module. The raw shapefile is never committed and never reaches the runtime.
 *
 * Source package, terms, vintage, and verified island coverage are recorded in
 * docs/research/sgis-boundary-acquisition.md.
 *
 * Usage:
 *   node scripts/generate-service-area.ts <path-to-bnd_sido_00_YYYY_NQ.shp>
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { writeZigzagVarint } from "../lib/zigzagVarint.ts";

/** Douglas-Peucker tolerance in source-projection metres. */
const SIMPLIFY_TOLERANCE_M = 10;
/** Tolerance is capped at this fraction of a ring's extent so small islands keep their shape. */
const SPAN_TOLERANCE_DIVISOR = 8;
/** Coordinate quantum in degrees (~1.1 m), an order of magnitude finer than the tolerance. */
const QUANTUM = 1e-5;
const SCALE = Math.round(1 / QUANTUM);

const OUTPUT_PATH = join(import.meta.dirname, "..", "lib", "locationServiceAreaData.ts");

// EPSG:5179 (Korea 2000 / Unified CS), read from the package's .prj.
const A = 6378137.0;
const INVERSE_FLATTENING = 298.257222101;
const F = 1 / INVERSE_FLATTENING;
const E2 = 2 * F - F * F;
const EP2 = E2 / (1 - E2);
const K0 = 0.9996;
const LAT0 = (38 * Math.PI) / 180;
const LON0 = (127.5 * Math.PI) / 180;
const FALSE_EASTING = 1_000_000;
const FALSE_NORTHING = 2_000_000;

function meridionalArc(phi: number): number {
  return (
    A *
    ((1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * phi -
      ((3 * E2) / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * E2 ** 3) / 3072) * Math.sin(6 * phi))
  );
}

const M0 = meridionalArc(LAT0);
const E1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));

/** Inverse Transverse Mercator: EPSG:5179 metres to WGS84 degrees. */
function toWgs84(x: number, y: number): [number, number] {
  const m = (y - FALSE_NORTHING) / K0 + M0;
  const mu = m / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256));
  const phi1 =
    mu +
    ((3 * E1) / 2 - (27 * E1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * E1 ** 2) / 16 - (55 * E1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * E1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * E1 ** 4) / 512) * Math.sin(8 * mu);
  const sinPhi1 = Math.sin(phi1);
  const c1 = EP2 * Math.cos(phi1) ** 2;
  const t1 = Math.tan(phi1) ** 2;
  const n1 = A / Math.sqrt(1 - E2 * sinPhi1 * sinPhi1);
  const r1 = (A * (1 - E2)) / (1 - E2 * sinPhi1 * sinPhi1) ** 1.5;
  const d = (x - FALSE_EASTING) / (n1 * K0);

  const lat =
    phi1 -
    ((n1 * Math.tan(phi1)) / r1) *
      (d ** 2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * EP2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * EP2 - 3 * c1 ** 2) * d ** 6) / 720);
  const lon =
    LON0 +
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * EP2 + 24 * t1 ** 2) * d ** 5) / 120) /
      Math.cos(phi1);

  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}

type Point = [number, number];

/**
 * Read each ESRI shapefile record of shape type 5 as one feature's ring list.
 *
 * Rings must stay grouped by feature: 전라남도 carries a hole where 광주광역시
 * sits, and 광주's own outer ring belongs to a different feature. Evaluating
 * holes across the whole layer would reject every coordinate in that city.
 */
function readFeatures(shp: Buffer): Point[][][] {
  const features: Point[][][] = [];
  let pos = 100;
  while (pos < shp.length) {
    const contentLength = shp.readInt32BE(pos + 4);
    const body = pos + 8;
    const shapeType = shp.readInt32LE(body);
    if (shapeType === 5) {
      const numParts = shp.readInt32LE(body + 36);
      const numPoints = shp.readInt32LE(body + 40);
      const partsOffset = body + 44;
      const pointsOffset = partsOffset + 4 * numParts;
      const parts: number[] = [];
      for (let i = 0; i < numParts; i += 1) {
        parts.push(shp.readInt32LE(partsOffset + 4 * i));
      }
      const rings: Point[][] = [];
      for (let i = 0; i < numParts; i += 1) {
        const start = parts[i];
        const end = i + 1 < numParts ? parts[i + 1] : numPoints;
        const ring: Point[] = [];
        for (let j = start; j < end; j += 1) {
          ring.push([
            shp.readDoubleLE(pointsOffset + 16 * j),
            shp.readDoubleLE(pointsOffset + 16 * j + 8),
          ]);
        }
        rings.push(ring);
      }
      features.push(rings);
    }
    pos = body + contentLength * 2;
  }
  return features;
}

/** Read the layer's boundary vintage from the sibling DBF's BASE_DATE column. */
function readBoundaryVintage(dbfPath: string): string {
  const dbf = readFileSync(dbfPath);
  const headerLength = dbf.readUInt16LE(8);
  const recordLength = dbf.readUInt16LE(10);
  let offset = 32;
  let columnOffset = 1;
  let found: number | null = null;
  let width = 0;
  while (dbf[offset] !== 0x0d) {
    const name = dbf.subarray(offset, offset + 11).toString("utf8").replace(/\0.*$/, "");
    const fieldWidth = dbf[offset + 16];
    if (name === "BASE_DATE") {
      found = columnOffset;
      width = fieldWidth;
    }
    columnOffset += fieldWidth;
    offset += 32;
  }
  if (found === null) throw new Error("boundary DBF has no BASE_DATE column");
  const raw = dbf
    .subarray(headerLength + found, headerLength + found + width)
    .toString("utf8")
    .trim();
  if (!/^\d{8}$/.test(raw)) throw new Error(`unexpected BASE_DATE value: ${raw}`);

  // Every record must share one vintage; a mixed package is not a valid source.
  const recordCount = dbf.readInt32LE(4);
  for (let record = 1; record < recordCount; record += 1) {
    const start = headerLength + record * recordLength + found;
    if (dbf.subarray(start, start + width).toString("utf8").trim() !== raw) {
      throw new Error("boundary DBF mixes BASE_DATE vintages");
    }
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

/** Shoelace area; shapefile outer rings are clockwise and therefore negative. */
function signedArea(ring: Point[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

function simplify(ring: Point[], tolerance: number): Point[] {
  const n = ring.length;
  if (n < 5) return ring;
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  keep[n - 1] = true;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    if (end <= start + 1) continue;
    const [x1, y1] = ring[start];
    const [x2, y2] = ring[end];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const segment = Math.hypot(dx, dy);
    let bestDistance = -1;
    let bestIndex = -1;
    for (let i = start + 1; i < end; i += 1) {
      const [px, py] = ring[i];
      const distance =
        segment === 0
          ? Math.hypot(px - x1, py - y1)
          : Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / segment;
      if (distance > bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    if (bestDistance > tolerance) {
      keep[bestIndex] = true;
      stack.push([start, bestIndex], [bestIndex, end]);
    }
  }
  return ring.filter((_, i) => keep[i]);
}

/**
 * Resolve the operator-supplied argument to the one shapefile this generator
 * accepts. Only an `bnd_<layer>_<code>_<year>_<quarter>.shp` basename from the
 * official package is allowed, so the argument selects a package location
 * rather than an arbitrary file to read.
 */
function resolveSourcePath(argument: string | undefined): string {
  if (!argument) {
    throw new Error("usage: npm run service-area:generate -- <bnd_sido_*.shp>");
  }
  const resolved = resolve(argument);
  if (!/^bnd_[a-z]+_\d+_\d{4}_\dQ\.shp$/.test(basename(resolved))) {
    throw new Error(`not an official SGIS boundary shapefile: ${basename(resolved)}`);
  }
  return resolved;
}

function main(): void {
  const shpPath = resolveSourcePath(process.argv[2]);

  const shp = readFileSync(shpPath);
  const sourceChecksum = createHash("sha256").update(shp).digest("hex");
  const boundaryVintage = readBoundaryVintage(shpPath.replace(/\.shp$/i, ".dbf"));
  const features = readFeatures(shp);

  const encoded: number[] = [];
  let ringCount = 0;
  let outerCount = 0;
  let holeCount = 0;
  let vertexCount = 0;

  writeZigzagVarint(encoded, features.length);

  for (const rings of features) {
    writeZigzagVarint(encoded, rings.length);
    for (const ring of rings) {
      const area = signedArea(ring);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      const span = Math.max(maxX - minX, maxY - minY);
      const tolerance = Math.min(SIMPLIFY_TOLERANCE_M, span / SPAN_TOLERANCE_DIVISOR);
      const simplified = simplify(ring, tolerance);

      ringCount += 1;
      if (area < 0) outerCount += 1;
      else holeCount += 1;
      vertexCount += simplified.length;

      writeZigzagVarint(encoded, simplified.length);
      let previousLon = 0;
      let previousLat = 0;
      for (const [x, y] of simplified) {
        const [lon, lat] = toWgs84(x, y);
        const qLon = Math.round(lon * SCALE);
        const qLat = Math.round(lat * SCALE);
        writeZigzagVarint(encoded, qLon - previousLon);
        writeZigzagVarint(encoded, qLat - previousLat);
        previousLon = qLon;
        previousLat = qLat;
      }
    }
  }

  const payload = Buffer.from(encoded);
  const payloadChecksum = createHash("sha256").update(payload).digest("hex");
  const base64 = payload.toString("base64");

  const generated = `// GENERATED FILE — do not edit by hand.
// Regenerate with: node scripts/generate-service-area.ts <bnd_sido_*.shp>
// Source package, terms, vintage, and verified island coverage:
// docs/research/sgis-boundary-acquisition.md

/** Provenance of the encoded service-area geometry. */
export const SERVICE_AREA_SOURCE = {
  dataset: "국가데이터처_SGIS 행정구역 통계 및 경계",
  layer: ${JSON.stringify(basename(shpPath))},
  boundaryVintage: ${JSON.stringify(boundaryVintage)},
  sourceChecksum: ${JSON.stringify(sourceChecksum)},
  payloadChecksum: ${JSON.stringify(payloadChecksum)},
  simplifyToleranceMetres: ${SIMPLIFY_TOLERANCE_M},
  coordinateQuantumDegrees: ${QUANTUM},
  featureCount: ${features.length},
  ringCount: ${ringCount},
  outerRingCount: ${outerCount},
  holeRingCount: ${holeCount},
  vertexCount: ${vertexCount},
} as const;

/**
 * Zigzag-varint delta-encoded WGS84 geometry, grouped by feature so holes are
 * only ever subtracted from their own feature. Decoded by locationServiceArea.ts.
 */
export const SERVICE_AREA_PAYLOAD =
  "${base64}";
`;

  writeFileSync(OUTPUT_PATH, generated);

  console.log(`source        ${shpPath}`);
  console.log(`source sha256 ${sourceChecksum}`);
  console.log(`vintage       ${boundaryVintage}`);
  console.log(`features      ${features.length}`);
  console.log(`rings         ${ringCount} (${outerCount} outer, ${holeCount} holes)`);
  console.log(`vertices      ${vertexCount}`);
  console.log(`payload       ${payload.length} bytes, base64 ${base64.length} bytes`);
  console.log(`payload sha256 ${payloadChecksum}`);
  console.log(`wrote         ${OUTPUT_PATH}`);
}

main();
