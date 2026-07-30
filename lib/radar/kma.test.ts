import { test } from "node:test";
import assert from "node:assert/strict";
import {
  frameKey,
  frameKeyToIso,
  isAllowedFrameKey,
  isValidFrameKey,
  latestFrameInstant,
} from "./kma.ts";

test("isValidFrameKey accepts a 12-digit KST key and rejects everything else", () => {
  assert.equal(isValidFrameKey("202606261105"), true);
  assert.equal(isValidFrameKey("2026062611"), false); // too short
  assert.equal(isValidFrameKey("2026062611055"), false); // too long
  assert.equal(isValidFrameKey("20260626110a"), false); // non-digit
  assert.equal(isValidFrameKey("../../etc/passwd"), false); // path traversal
  assert.equal(isValidFrameKey("202602300105"), false); // impossible calendar date
  assert.equal(isValidFrameKey("202606261107"), false); // not a five-minute frame
  assert.equal(isValidFrameKey("202606262405"), false); // impossible hour
  assert.equal(isValidFrameKey(""), false);
});

test("isAllowedFrameKey accepts only a tight recent-frame window", () => {
  // 02:14 UTC = 11:14 KST; after the seven-minute publication lag, latest is 11:05 KST.
  const nowMs = Date.parse("2026-06-26T02:14:00.000Z");
  assert.equal(isAllowedFrameKey("202606261105", nowMs), true);
  assert.equal(isAllowedFrameKey("202606261005", nowMs), true);
  assert.equal(isAllowedFrameKey("202606260935", nowMs), true);
  assert.equal(isAllowedFrameKey("202606260930", nowMs), false); // older than 90-minute grace window
  assert.equal(isAllowedFrameKey("202606261110", nowMs), false); // future/unpublished frame
});

test("frameKey ↔ frameKeyToIso round-trips through the KST shift", () => {
  const key = "202606261105";
  const iso = frameKeyToIso(key);
  // KST 11:05 → 02:05 UTC the same day.
  assert.equal(iso, "2026-06-26T02:05:00.000Z");
  const kstShifted = new Date(Date.parse(iso) + 9 * 3600_000);
  assert.equal(frameKey(kstShifted), key);
});

test("latestFrameInstant lands on a 5-minute KST boundary", () => {
  const key = frameKey(latestFrameInstant());
  assert.match(key, /^\d{12}$/);
  assert.equal(Number(key.slice(10, 12)) % 5, 0);
});
