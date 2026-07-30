import { deflateSync } from "node:zlib";

/**
 * Pure decoder + colouring for the KMA high-resolution radar grid (apihub.kma.go.kr
 * `nph-rdr_cmp1_api`, product HSR, `disp=B`). No network, no env, no geo — just bytes
 * in, RGBA/PNG out — so it is fully unit-testable.
 *
 * disp=B layout (verified): a 4-byte header `[int16 nx][int16 ny]` (little-endian)
 * followed by `nx*ny` int16 LE cells in row-major order with **iy=0 at the SOUTH**.
 * A real echo cell holds `dBZ * 100`; everything else is a no-data sentinel
 * (−30000 outside coverage, −25000 in-coverage no echo, −20100 clutter) → transparent.
 *
 * The national grid is 2305×2881 @ ~500 m. We only ever read the fixed Seoul-metro
 * window (see CROP) — 148×142 cells, ~76×73 km — never the whole 13 MB body.
 */

export const GRID_NX = 2305;
export const GRID_NY = 2881;

/**
 * Fixed Seoul-metro crop window (inclusive cell indices). Verified against the KMA
 * latlon grid: these corners bound lat 37.20–37.85, lon 126.50–127.35.
 */
export const CROP = { ix0: 1206, ix1: 1353, iy0: 1508, iy1: 1649 } as const;
export const CROP_W = CROP.ix1 - CROP.ix0 + 1; // 148
export const CROP_H = CROP.iy1 - CROP.iy0 + 1; // 142

/** disp=B no-data sentinels (all ≤ −20100; real echo is dBZ×100, never this low). */
export const SENTINEL = { outside: -30000, noEcho: -25000, clutter: -20100 } as const;

const HEADER_BYTES = 4;

/** Validate the disp=B header + total length; throws on any mismatch. */
export function parseHeader(buf: ArrayBuffer): { nx: number; ny: number } {
  if (buf.byteLength < HEADER_BYTES) throw new Error("radar grid: short buffer");
  const dv = new DataView(buf);
  const nx = dv.getInt16(0, true);
  const ny = dv.getInt16(2, true);
  if (nx !== GRID_NX || ny !== GRID_NY) {
    throw new Error(`radar grid: unexpected dims ${nx}x${ny}`);
  }
  const expected = HEADER_BYTES + nx * ny * 2;
  if (buf.byteLength !== expected) {
    throw new Error(`radar grid: length ${buf.byteLength} != ${expected}`);
  }
  return { nx, ny };
}

/**
 * Crop the full disp=B body to the Seoul window as raw int16, read explicitly as
 * little-endian (endian-safe on any host). The result is **south-up**: row r maps to
 * iy = iy0 + r (iy increases north, so row 0 is the SOUTH edge) and col c maps to
 * ix = ix0 + c. The north-up flip is applied during reprojection (see geo.ts).
 */
export function cropToSeoul(buf: ArrayBuffer): Int16Array {
  parseHeader(buf);
  const dv = new DataView(buf);
  const out = new Int16Array(CROP_W * CROP_H);
  for (let r = 0; r < CROP_H; r++) {
    const rowBase = HEADER_BYTES + (CROP.iy0 + r) * GRID_NX * 2;
    for (let c = 0; c < CROP_W; c++) {
      out[r * CROP_W + c] = dv.getInt16(rowBase + (CROP.ix0 + c) * 2, true);
    }
  }
  return out;
}

/**
 * Raw int16 → dBZ, or `null` for any no-data/sentinel. The three known sentinels are
 * all ≤ −20100 and no real echo in this product is below ~−10 dBZ, so a single
 * `≤ −1000` floor cleanly separates no-data from signal.
 */
export function dbzFromRaw(raw: number): number | null {
  if (!Number.isFinite(raw) || raw <= -1000) return null;
  return raw / 100;
}

export type Rgba = [number, number, number, number];

/**
 * Single-hue cinematic luminance ramp, transparent → indigo → cyan → white. Stops are
 * `[dBZ, r, g, b, a]`, monotonically increasing in BOTH colour-luminance and alpha so
 * the echo reads on a dark basemap (light rain = translucent wash, cores = white-hot)
 * and maps cleanly onto 약함·보통·강함.
 */
const RAMP: readonly [number, number, number, number, number][] = [
  [5, 40, 50, 130, 60],
  [15, 40, 90, 190, 120],
  [25, 40, 160, 210, 180],
  [35, 90, 220, 230, 220],
  [45, 200, 245, 245, 245],
  [55, 255, 255, 255, 255],
];

/** dBZ (or null) → RGBA. Below the lightest stop (and all no-data) is fully transparent. */
export function dbzToRgba(dbz: number | null): Rgba {
  const top = RAMP[RAMP.length - 1];
  if (dbz === null || dbz < RAMP[0][0]) return [0, 0, 0, 0];
  if (dbz >= top[0]) return [top[1], top[2], top[3], top[4]];
  for (let i = 1; i < RAMP.length; i++) {
    if (dbz <= RAMP[i][0]) {
      const lo = RAMP[i - 1];
      const hi = RAMP[i];
      const t = (dbz - lo[0]) / (hi[0] - lo[0]);
      return [
        Math.round(lo[1] + (hi[1] - lo[1]) * t),
        Math.round(lo[2] + (hi[2] - lo[2]) * t),
        Math.round(lo[3] + (hi[3] - lo[3]) * t),
        Math.round(lo[4] + (hi[4] - lo[4]) * t),
      ];
    }
  }
  return [top[1], top[2], top[3], top[4]];
}

// ---- PNG encoding (hand-rolled via zlib; zero deps) --------------------------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

/** Encode a w×h RGBA buffer (length w*h*4) into 8-bit RGBA PNG bytes. */
export function encodePng(rgba: Uint8Array, w: number, h: number): Buffer {
  if (!Number.isSafeInteger(w) || w <= 0 || !Number.isSafeInteger(h) || h <= 0) {
    throw new Error("encodePng: invalid dimensions");
  }
  if (rgba.length !== w * h * 4) throw new Error("encodePng: rgba size mismatch");
  const stride = w * 4;
  const filtered = Buffer.allocUnsafe(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1);
    filtered[o] = 0; // filter type 0 (none)
    filtered.set(rgba.subarray(y * stride, (y + 1) * stride), o + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(filtered, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
