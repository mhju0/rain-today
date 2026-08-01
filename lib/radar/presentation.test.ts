import { test } from "node:test";
import assert from "node:assert/strict";
import type { KmaRadarFrame } from "../types.ts";
import {
  advanceRadarFrame,
  buildRadarMosaic,
  formatRadarFrameTime,
  orderedRadarWarmup,
  radarApproachSummary,
  radarFrameTag,
  resolveRadarTimeline,
} from "./presentation.ts";

const frame = (time: string): KmaRadarFrame => ({
  t: time.replace(/\D/g, "").slice(0, 12),
  time,
  nowcast: false,
});

test("radarApproachSummary never invents an approach direction", () => {
  assert.equal(radarApproachSummary(null), "레이더 관측 없음");
  assert.equal(
    radarApproachSummary({ approaching: true, fromDirection: "북서", precipNearby: true }),
    "북서쪽에서 비구름 접근 중",
  );
  assert.equal(
    radarApproachSummary({ approaching: true, fromDirection: null, precipNearby: true }),
    "서울 부근에 강수 관측",
  );
  assert.equal(
    radarApproachSummary({ approaching: null, fromDirection: null, precipNearby: false }),
    "접근하는 비구름 없음",
  );
});

test("radarFrameTag describes observed frames relative to the latest observation", () => {
  const latest = Date.parse("2026-07-14T07:00:00.000Z");
  assert.equal(radarFrameTag(frame("2026-07-14T07:00:00.000Z"), latest), "실시간 · 관측");
  assert.equal(radarFrameTag(frame("2026-07-14T06:50:00.000Z"), latest), "-10분 · 관측");
  assert.equal(radarFrameTag(frame("not-a-time"), latest), "관측 시간 확인 불가");
});

test("formatRadarFrameTime is KST-specific and safe for malformed upstream times", () => {
  assert.equal(formatRadarFrameTime("2026-07-14T07:00:00.000Z"), "16:00");
  assert.equal(formatRadarFrameTime("not-a-time"), "--:--");
});

test("resolveRadarTimeline safely clamps an out-of-range playhead", () => {
  const frames = [
    frame("2026-07-14T06:50:00.000Z"),
    frame("2026-07-14T06:55:00.000Z"),
    frame("2026-07-14T07:00:00.000Z"),
  ];

  assert.deepEqual(resolveRadarTimeline(frames, 99), {
    activeIndex: 2,
    latestIndex: 2,
    latestObservedMs: Date.parse("2026-07-14T07:00:00.000Z"),
  });
  assert.deepEqual(resolveRadarTimeline([], -1), {
    activeIndex: 0,
    latestIndex: 0,
    latestObservedMs: null,
  });
});

test("advanceRadarFrame loops without producing invalid indices", () => {
  assert.equal(advanceRadarFrame(0, 0), 0);
  assert.equal(advanceRadarFrame(1, 3), 2);
  assert.equal(advanceRadarFrame(2, 3), 0);
  assert.equal(advanceRadarFrame(99, 3), 0);
});

test("orderedRadarWarmup starts at the active frame and follows playback order once", () => {
  const frames = [
    frame("2026-07-14T06:45:00.000Z"),
    frame("2026-07-14T06:50:00.000Z"),
    frame("2026-07-14T06:55:00.000Z"),
    frame("2026-07-14T07:00:00.000Z"),
  ];

  assert.deepEqual(
    orderedRadarWarmup(frames, 2).map((candidate) => candidate.time),
    [
      "2026-07-14T06:55:00.000Z",
      "2026-07-14T07:00:00.000Z",
      "2026-07-14T06:45:00.000Z",
      "2026-07-14T06:50:00.000Z",
    ],
  );
});

test("orderedRadarWarmup is safe for empty and single-frame timelines", () => {
  const only = frame("2026-07-14T07:00:00.000Z");

  assert.deepEqual(orderedRadarWarmup([], 0), []);
  assert.deepEqual(orderedRadarWarmup([only], 0), [only]);
});

test("buildRadarMosaic keeps basemap tiles and labels registered to the bounds", () => {
  const mosaic = buildRadarMosaic({ west: 126.5, east: 127.35, south: 37.2, north: 37.85 });

  assert.ok(mosaic.wpW > 0);
  assert.ok(mosaic.wpH > 0);
  assert.ok(mosaic.tiles.length > 0);
  assert.match(mosaic.tiles[0].url, /^https:\/\/[a-d]\.basemaps\.cartocdn\.com\/dark_nolabels\/10\//);
  assert.ok(mosaic.labels.some((label) => label.ko === "서울"));
  assert.ok(mosaic.labels.every((label) => label.left >= 0 && label.left <= 100));
  assert.ok(mosaic.labels.every((label) => label.top >= 0 && label.top <= 100));
});
