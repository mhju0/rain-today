import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import fc from "fast-check";
import {
  CROP,
  CROP_H,
  CROP_W,
  cropToSeoul,
  dbzFromRaw,
  dbzToRgba,
  encodePng,
  GRID_NX,
  GRID_NY,
  parseHeader,
  SENTINEL,
} from "./grid.ts";

const HEADER = 4;

function fullGrid(): { buf: ArrayBuffer; dv: DataView } {
  const buf = new ArrayBuffer(HEADER + GRID_NX * GRID_NY * 2);
  const dv = new DataView(buf);
  dv.setInt16(0, GRID_NX, true);
  dv.setInt16(2, GRID_NY, true);
  return { buf, dv };
}

const cellOffset = (ix: number, iy: number) => HEADER + (iy * GRID_NX + ix) * 2;

test("parseHeader accepts the verified dims and total length", () => {
  const { buf } = fullGrid();
  assert.deepEqual(parseHeader(buf), { nx: GRID_NX, ny: GRID_NY });
});

test("parseHeader rejects short, wrong-dims, and wrong-length buffers", () => {
  assert.throws(() => parseHeader(new ArrayBuffer(2)), /short buffer/);

  const wrongDims = new ArrayBuffer(HEADER + 8);
  new DataView(wrongDims).setInt16(0, 100, true);
  assert.throws(() => parseHeader(wrongDims), /unexpected dims/);

  const wrongLen = new ArrayBuffer(HEADER + 8);
  const dv = new DataView(wrongLen);
  dv.setInt16(0, GRID_NX, true);
  dv.setInt16(2, GRID_NY, true);
  assert.throws(() => parseHeader(wrongLen), /length/);
});

test("cropToSeoul is south-up: row 0 = south edge, row H-1 = north edge", () => {
  const { buf, dv } = fullGrid();
  // Default body is 0; mark the SW (south) and NW (north) corners of the crop.
  dv.setInt16(cellOffset(CROP.ix0, CROP.iy0), 1234, true); // south edge
  dv.setInt16(cellOffset(CROP.ix0, CROP.iy1), 4321, true); // north edge
  dv.setInt16(cellOffset(CROP.ix0 + 3, CROP.iy0 + 3), SENTINEL.clutter, true);

  const crop = cropToSeoul(buf);
  assert.equal(crop.length, CROP_W * CROP_H);
  assert.equal(crop[0], 1234); // row 0, col 0 = (ix0, iy0) = south
  assert.equal(crop[(CROP_H - 1) * CROP_W + 0], 4321); // row H-1 = north
  assert.equal(crop[3 * CROP_W + 3], SENTINEL.clutter);
});

test("dbzFromRaw maps sentinels to null and scales real echo by 1/100", () => {
  assert.equal(dbzFromRaw(SENTINEL.outside), null);
  assert.equal(dbzFromRaw(SENTINEL.noEcho), null);
  assert.equal(dbzFromRaw(SENTINEL.clutter), null);
  assert.equal(dbzFromRaw(3500), 35);
  assert.equal(dbzFromRaw(0), 0);
});

test("dbzFromRaw never lets non-finite generated input reach rendering math", () => {
  fc.assert(
    fc.property(fc.double(), (raw) => {
      const decoded = dbzFromRaw(raw);
      assert.ok(decoded === null || Number.isFinite(decoded));
    }),
  );
});

test("dbzToRgba: transparent below 5 dBZ and for no-data, white-hot at the top", () => {
  assert.deepEqual(dbzToRgba(null), [0, 0, 0, 0]);
  assert.deepEqual(dbzToRgba(4.9), [0, 0, 0, 0]);
  assert.deepEqual(dbzToRgba(60), [255, 255, 255, 255]);
});

test("dbzToRgba ramp is monotonic in both luminance and alpha", () => {
  const luma = ([r, g, b]: number[]) => 0.299 * r + 0.587 * g + 0.114 * b;
  let prevL = -1;
  let prevA = -1;
  for (let d = 5; d <= 55; d++) {
    const c = dbzToRgba(d);
    assert.ok(luma(c) >= prevL - 1e-9, `luminance dropped at ${d} dBZ`);
    assert.ok(c[3] >= prevA, `alpha dropped at ${d} dBZ`);
    prevL = luma(c);
    prevA = c[3];
  }
});

test("encodePng emits a valid RGBA PNG whose IDAT inflates to the filtered scanlines", () => {
  const w = 3;
  const h = 2;
  const rgba = new Uint8Array(w * h * 4).fill(200);
  const png = encodePng(rgba, w, h);

  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  assert.equal(png.readUInt32BE(16), w);
  assert.equal(png.readUInt32BE(20), h);

  const idatLen = png.readUInt32BE(33);
  assert.equal(png.subarray(37, 41).toString("ascii"), "IDAT");
  const raw = inflateSync(png.subarray(41, 41 + idatLen));
  assert.equal(raw.length, h * (w * 4 + 1)); // one filter byte per row
  assert.equal(raw[0], 0); // filter type 0 (none)
});

test("encodePng rejects a mismatched buffer size", () => {
  assert.throws(() => encodePng(new Uint8Array(3), 2, 2), /size mismatch/);
});

test("encodePng rejects generated zero-sized canvases", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 4096 }), (otherDimension) => {
      assert.throws(
        () => encodePng(new Uint8Array(0), 0, otherDimension),
        /invalid dimensions/,
      );
      assert.throws(
        () => encodePng(new Uint8Array(0), otherDimension, 0),
        /invalid dimensions/,
      );
    }),
  );
});
