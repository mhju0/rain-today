import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeRainViewerPng,
  normalizeRainViewerHost,
  validateRainViewerPath,
} from "./radar.ts";

test("RainViewer tile URLs are restricted to the expected HTTPS origin and path", () => {
  assert.equal(normalizeRainViewerHost("https://tilecache.rainviewer.com"), "https://tilecache.rainviewer.com");
  assert.equal(normalizeRainViewerHost("http://tilecache.rainviewer.com"), null);
  assert.equal(normalizeRainViewerHost("https://127.0.0.1"), null);
  assert.equal(normalizeRainViewerHost("https://tilecache.rainviewer.com.evil.example"), null);
  assert.equal(validateRainViewerPath("/v2/radar/1234567890"), true);
  assert.equal(validateRainViewerPath("/v2/radar/../../metadata"), false);
  assert.equal(validateRainViewerPath("https://evil.example/tile"), false);
});

test("RainViewer decoder rejects non-256x256 images before decompression", () => {
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(100_000, 16);
  png.writeUInt32BE(100_000, 20);
  png[24] = 8;
  png[25] = 6;
  assert.equal(decodeRainViewerPng(png), null);
});
