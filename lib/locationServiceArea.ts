import { SERVICE_AREA_PAYLOAD, SERVICE_AREA_SOURCE } from "./locationServiceAreaData.ts";
import { createZigzagVarintReader } from "./zigzagVarint.ts";

export { SERVICE_AREA_SOURCE };

/**
 * Server-only containment test for the South Korea service area.
 *
 * The geometry is the official SGIS 시도 boundary set, simplified in its source
 * projection and reprojected to WGS84 offline. Provenance, terms, measured
 * accuracy, and the verified island set are recorded in
 * docs/research/sgis-boundary-acquisition.md.
 *
 * Decoding happens once per process on the first query. `location.ts` builds
 * DEFAULT_FORECAST_LOCATION at module scope, so in practice that cost is paid
 * when this module's importer is first loaded, not on a later request.
 */

const SCALE = Math.round(1 / SERVICE_AREA_SOURCE.coordinateQuantumDegrees);

interface ServiceAreaGeometry {
  /** Interleaved quantized longitude/latitude pairs for every ring. */
  coordinates: Int32Array;
  /** Index of each ring's first coordinate pair. */
  ringStarts: Int32Array;
  /** Coordinate-pair count for each ring. */
  ringLengths: Int32Array;
  /** Quantized minLon, minLat, maxLon, maxLat for each ring. */
  ringBounds: Int32Array;
  /** Index of each feature's first ring, with a trailing end index. */
  featureRingStarts: Int32Array;
}

let geometry: ServiceAreaGeometry | null = null;

function decodeGeometry(): ServiceAreaGeometry {
  const payload = Buffer.from(SERVICE_AREA_PAYLOAD, "base64");
  const { featureCount, ringCount, vertexCount } = SERVICE_AREA_SOURCE;

  const coordinates = new Int32Array(vertexCount * 2);
  const ringStarts = new Int32Array(ringCount);
  const ringLengths = new Int32Array(ringCount);
  const ringBounds = new Int32Array(ringCount * 4);
  const featureRingStarts = new Int32Array(featureCount + 1);

  let vertex = 0;
  let ring = 0;

  const reader = createZigzagVarintReader(payload);

  if (reader.read() !== featureCount) {
    throw new Error("service-area asset feature count does not match its metadata");
  }

  for (let feature = 0; feature < featureCount; feature += 1) {
    featureRingStarts[feature] = ring;
    const featureRings = reader.read();

    for (let r = 0; r < featureRings; r += 1) {
      const length = reader.read();
      ringStarts[ring] = vertex;
      ringLengths[ring] = length;

      let lon = 0;
      let lat = 0;
      let minLon = Infinity;
      let minLat = Infinity;
      let maxLon = -Infinity;
      let maxLat = -Infinity;

      for (let i = 0; i < length; i += 1) {
        lon += reader.read();
        lat += reader.read();
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
      ring += 1;
    }
  }
  featureRingStarts[featureCount] = ring;

  if (vertex !== vertexCount || ring !== ringCount || reader.position() !== payload.length) {
    throw new Error("service-area asset is truncated or corrupt");
  }

  return { coordinates, ringStarts, ringLengths, ringBounds, featureRingStarts };
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
  const { featureRingStarts } = data;

  // Each feature is evaluated on its own. 전라남도 carries a hole where
  // 광주광역시 sits, so a hole must never cancel another feature's land.
  // Within one feature, odd ring nesting means inside: an outer ring counts 1,
  // a hole inside it counts 2, and an island inside that hole counts 3.
  for (let feature = 0; feature + 1 < featureRingStarts.length; feature += 1) {
    let depth = 0;
    for (let ring = featureRingStarts[feature]; ring < featureRingStarts[feature + 1]; ring += 1) {
      const bounds = ring * 4;
      if (
        lon < data.ringBounds[bounds] ||
        lon > data.ringBounds[bounds + 2] ||
        lat < data.ringBounds[bounds + 1] ||
        lat > data.ringBounds[bounds + 3]
      ) {
        continue;
      }
      if (ringContains(data, ring, lon, lat)) depth += 1;
    }
    if (depth % 2 === 1) return true;
  }

  return false;
}
