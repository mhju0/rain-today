import { SERVICE_AREA_PAYLOAD, SERVICE_AREA_SOURCE } from "./locationServiceAreaData.ts";

export { SERVICE_AREA_SOURCE };

/**
 * Server-only containment test for the South Korea service area.
 *
 * The geometry is the official SGIS 시도 boundary set, simplified in its source
 * projection and reprojected to WGS84 offline. Provenance, terms, measured
 * accuracy, and the verified island set are recorded in
 * docs/research/sgis-boundary-acquisition.md.
 *
 * Decoding is deferred to the first query so importing this module stays cheap.
 */

const SCALE = Math.round(1 / SERVICE_AREA_SOURCE.coordinateQuantumDegrees);

interface ServiceAreaGeometry {
  /** Interleaved quantized longitude/latitude pairs for every ring. */
  coordinates: Int32Array;
  /** Index of each ring's first coordinate pair. */
  ringStarts: Int32Array;
  /** Coordinate-pair count for each ring. */
  ringLengths: Int32Array;
  /** 1 for an outer ring, 0 for a hole. */
  ringIsOuter: Uint8Array;
  /** Quantized minLon, minLat, maxLon, maxLat for each ring. */
  ringBounds: Int32Array;
}

let geometry: ServiceAreaGeometry | null = null;

function decodeGeometry(): ServiceAreaGeometry {
  const payload = Buffer.from(SERVICE_AREA_PAYLOAD, "base64");
  const { ringCount, vertexCount } = SERVICE_AREA_SOURCE;

  const coordinates = new Int32Array(vertexCount * 2);
  const ringStarts = new Int32Array(ringCount);
  const ringLengths = new Int32Array(ringCount);
  const ringIsOuter = new Uint8Array(ringCount);
  const ringBounds = new Int32Array(ringCount * 4);

  let cursor = 0;
  let vertex = 0;

  const readVarint = (): number => {
    let result = 0;
    let shift = 1;
    for (;;) {
      const byte = payload[cursor];
      cursor += 1;
      result += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) break;
      shift *= 128;
    }
    return result % 2 === 0 ? result / 2 : -(result + 1) / 2;
  };

  for (let ring = 0; ring < ringCount; ring += 1) {
    const length = readVarint();
    ringIsOuter[ring] = readVarint() === 1 ? 1 : 0;
    ringStarts[ring] = vertex;
    ringLengths[ring] = length;

    let lon = 0;
    let lat = 0;
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;

    for (let i = 0; i < length; i += 1) {
      lon += readVarint();
      lat += readVarint();
      coordinates[vertex * 2] = lon;
      coordinates[vertex * 2 + 1] = lat;
      vertex += 1;
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }

    ringBounds[ring * 4] = minLon;
    ringBounds[ring * 4 + 1] = minLat;
    ringBounds[ring * 4 + 2] = maxLon;
    ringBounds[ring * 4 + 3] = maxLat;
  }

  if (vertex !== vertexCount || cursor !== payload.length) {
    throw new Error("service-area asset is truncated or corrupt");
  }

  return { coordinates, ringStarts, ringLengths, ringIsOuter, ringBounds };
}

function ringContains(
  data: ServiceAreaGeometry,
  ring: number,
  lon: number,
  lat: number,
): boolean {
  const start = data.ringStarts[ring];
  const length = data.ringLengths[ring];
  const { coordinates } = data;
  let inside = false;
  let j = length - 1;
  for (let i = 0; i < length; i += 1) {
    const xi = coordinates[(start + i) * 2];
    const yi = coordinates[(start + i) * 2 + 1];
    const xj = coordinates[(start + j) * 2];
    const yj = coordinates[(start + j) * 2 + 1];
    if (yi > lat !== yj > lat) {
      const crossing = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
      if (lon < crossing) inside = !inside;
    }
    j = i;
  }
  return inside;
}

/**
 * Report whether a WGS84 coordinate falls on South Korean land inside the
 * supported service area. Sea, foreign land, and non-finite input all reject.
 */
export function isInsideServiceArea(latitude: number, longitude: number): boolean {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;

  geometry ??= decodeGeometry();
  const data = geometry;
  const lon = Math.round(longitude * SCALE);
  const lat = Math.round(latitude * SCALE);

  let insideOuter = false;
  let insideHole = false;

  for (let ring = 0; ring < data.ringLengths.length; ring += 1) {
    const bounds = ring * 4;
    if (
      lon < data.ringBounds[bounds] ||
      lon > data.ringBounds[bounds + 2] ||
      lat < data.ringBounds[bounds + 1] ||
      lat > data.ringBounds[bounds + 3]
    ) {
      continue;
    }
    if (!ringContains(data, ring, lon, lat)) continue;
    if (data.ringIsOuter[ring] === 1) insideOuter = true;
    else insideHole = true;
  }

  return insideOuter && !insideHole;
}
