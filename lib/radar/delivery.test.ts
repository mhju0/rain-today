import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import type { KmaRadarFrames } from "../types.ts";
import {
  createRadarDelivery,
  type RadarDeliveryDependencies,
  type RadarFrameResult,
} from "./delivery.ts";
import { deliverRadarFrame, deliverRadarTimeline } from "./http.ts";
import { KmaRadarSourceError } from "./kma.ts";

const NOW = Date.parse("2026-06-26T02:14:00.000Z");
const KEYS = [
  "202606261005",
  "202606261010",
  "202606261015",
  "202606261020",
  "202606261025",
  "202606261030",
  "202606261035",
  "202606261040",
  "202606261045",
  "202606261050",
  "202606261055",
  "202606261100",
  "202606261105",
] as const;
const BOUNDS = { west: 126.7, east: 127.3, south: 37.3, north: 37.8 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function configuredKma(
  render: RadarDeliveryDependencies["kma"]["render"],
): RadarDeliveryDependencies["kma"] {
  return {
    configured: () => true,
    bounds: async () => BOUNDS,
    render,
  };
}

function assertKind<TKind extends RadarFrameResult["kind"]>(
  result: RadarFrameResult,
  kind: TKind,
): asserts result is Extract<RadarFrameResult, { kind: TKind }> {
  assert.equal(result.kind, kind);
}

test("invalid frame keys perform no KMA reads", async () => {
  let configurationReads = 0;
  let boundsReads = 0;
  let renders = 0;
  const delivery = createRadarDelivery(
    {
      kma: {
        configured: () => {
          configurationReads += 1;
          return true;
        },
        bounds: async () => {
          boundsReads += 1;
          return BOUNDS;
        },
        render: async () => {
          renders += 1;
          return Buffer.from("unexpected");
        },
      },
    },
    { now: () => NOW, maxConcurrent: 2, maxQueued: 16 },
  );

  assert.deepEqual(await delivery.frame("202606261107"), { kind: "invalid" });
  assert.deepEqual(await delivery.frame("../../etc/passwd"), { kind: "invalid" });
  assert.deepEqual({ configurationReads, boundsReads, renders }, {
    configurationReads: 0,
    boundsReads: 0,
    renders: 0,
  });
});

test("same-key callers share one pending KMA render", async () => {
  const rendered = deferred<Buffer>();
  let renders = 0;
  const delivery = createRadarDelivery(
    {
      kma: configuredKma(async () => {
        renders += 1;
        return rendered.promise;
      }),
    },
    { now: () => NOW, maxConcurrent: 2, maxQueued: 16 },
  );

  const first = delivery.frame(KEYS[12]);
  const second = delivery.frame(KEYS[12]);
  await nextTurn();
  assert.equal(renders, 1);

  rendered.resolve(Buffer.from("shared-png"));
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.kind), ["ready", "ready"]);
  for (const result of results) {
    assertKind(result, "ready");
    assert.equal(result.png.toString(), "shared-png");
  }
});

test("thirteen distinct frame calls never exceed configured render capacity", async () => {
  let active = 0;
  let maxObserved = 0;
  const delivery = createRadarDelivery(
    {
      kma: configuredKma(async (key) => {
        active += 1;
        maxObserved = Math.max(maxObserved, active);
        await nextTurn();
        active -= 1;
        return Buffer.from(key);
      }),
    },
    { now: () => NOW, maxConcurrent: 2, maxQueued: 16 },
  );

  const results = await Promise.all(KEYS.map((key) => delivery.frame(key)));

  assert.equal(maxObserved, 2);
  assert.equal(results.filter((result) => result.kind === "ready").length, 13);
});

test("aborted queued work leaves the queue without reaching KMA", async () => {
  const releaseFirst = deferred<Buffer>();
  const firstStarted = deferred<void>();
  const renderedKeys: string[] = [];
  const delivery = createRadarDelivery(
    {
      kma: configuredKma(async (key) => {
        renderedKeys.push(key);
        if (key === KEYS[0]) {
          firstStarted.resolve();
          return releaseFirst.promise;
        }
        return Buffer.from(key);
      }),
    },
    { now: () => NOW, maxConcurrent: 1, maxQueued: 2 },
  );

  const first = delivery.frame(KEYS[0]);
  await firstStarted.promise;
  const controller = new AbortController();
  const queued = delivery.frame(KEYS[1], controller.signal);
  await nextTurn();
  controller.abort();

  assert.deepEqual(await queued, { kind: "cancelled" });
  assert.deepEqual(renderedKeys, [KEYS[0]]);

  releaseFirst.resolve(Buffer.from(KEYS[0]));
  assertKind(await first, "ready");
  assertKind(await delivery.frame(KEYS[2]), "ready");
  assert.deepEqual(renderedKeys, [KEYS[0], KEYS[2]]);
});

test("an aborted queued key can be retried immediately", async () => {
  const releaseFirst = deferred<Buffer>();
  const firstStarted = deferred<void>();
  const renderedKeys: string[] = [];
  const delivery = createRadarDelivery(
    {
      kma: configuredKma(async (key) => {
        renderedKeys.push(key);
        if (key === KEYS[0]) {
          firstStarted.resolve();
          return releaseFirst.promise;
        }
        return Buffer.from(key);
      }),
    },
    { now: () => NOW, maxConcurrent: 1, maxQueued: 2 },
  );

  const first = delivery.frame(KEYS[0]);
  await firstStarted.promise;
  const controller = new AbortController();
  const cancelled = delivery.frame(KEYS[1], controller.signal);
  await nextTurn();
  controller.abort();
  assert.deepEqual(await cancelled, { kind: "cancelled" });

  const retry = delivery.frame(KEYS[1]);
  releaseFirst.resolve(Buffer.from(KEYS[0]));

  assertKind(await first, "ready");
  assertKind(await retry, "ready");
  assert.deepEqual(renderedKeys, [KEYS[0], KEYS[1]]);
});

test("one same-key caller can cancel without cancelling another subscriber", async () => {
  const rendered = deferred<Buffer>();
  let renders = 0;
  const delivery = createRadarDelivery(
    {
      kma: configuredKma(async () => {
        renders += 1;
        return rendered.promise;
      }),
    },
    { now: () => NOW, maxConcurrent: 1, maxQueued: 2 },
  );
  const controller = new AbortController();
  const cancelled = delivery.frame(KEYS[0], controller.signal);
  const surviving = delivery.frame(KEYS[0]);
  await nextTurn();

  controller.abort();
  assert.deepEqual(await cancelled, { kind: "cancelled" });
  rendered.resolve(Buffer.from("survived"));

  const result = await surviving;
  assertKind(result, "ready");
  assert.equal(result.png.toString(), "survived");
  assert.equal(renders, 1);
});

test("a late cancelled render cannot populate the cache ahead of its retry", async () => {
  const firstStarted = deferred<void>();
  const retryStarted = deferred<void>();
  const lateCancelledBytes = deferred<Buffer>();
  const retryBytes = deferred<Buffer>();
  let renders = 0;
  const delivery = createRadarDelivery(
    {
      kma: configuredKma(async () => {
        renders += 1;
        if (renders === 1) {
          firstStarted.resolve();
          return lateCancelledBytes.promise;
        }
        retryStarted.resolve();
        return retryBytes.promise;
      }),
    },
    { now: () => NOW, maxConcurrent: 1, maxQueued: 2 },
  );

  const controller = new AbortController();
  const cancelled = delivery.frame(KEYS[0], controller.signal);
  await firstStarted.promise;
  controller.abort();
  assert.deepEqual(await cancelled, { kind: "cancelled" });

  const retry = delivery.frame(KEYS[0]);
  lateCancelledBytes.resolve(Buffer.from("late-cancelled"));
  await retryStarted.promise;
  const joinsRetry = delivery.frame(KEYS[0]);
  retryBytes.resolve(Buffer.from("fresh-retry"));

  const results = await Promise.all([retry, joinsRetry]);
  for (const result of results) {
    assertKind(result, "ready");
    assert.equal(result.png.toString(), "fresh-retry");
  }
  assert.equal(renders, 2);
});

test("a resolve-then-queued abort cannot cache the cancelled generation", async () => {
  const firstStarted = deferred<void>();
  const firstBytes = deferred<Buffer>();
  let renders = 0;
  const delivery = createRadarDelivery(
    {
      kma: configuredKma(() => {
        renders += 1;
        if (renders === 1) {
          firstStarted.resolve();
          return firstBytes.promise;
        }
        return Promise.resolve(Buffer.from("fresh-after-abort"));
      }),
    },
    { now: () => NOW, maxConcurrent: 1, maxQueued: 2 },
  );

  const controller = new AbortController();
  const cancelled = delivery.frame(KEYS[0], controller.signal);
  await firstStarted.promise;
  firstBytes.resolve(Buffer.from("resolved-before-abort"));
  queueMicrotask(() => controller.abort());

  assert.deepEqual(await cancelled, { kind: "cancelled" });
  const retry = await delivery.frame(KEYS[0]);
  assertKind(retry, "ready");
  assert.equal(retry.png.toString(), "fresh-after-abort");
  assert.equal(renders, 2);
});

test("a full admission queue returns busy without reaching KMA", async () => {
  const releaseFirst = deferred<Buffer>();
  const firstStarted = deferred<void>();
  const renderedKeys: string[] = [];
  const delivery = createRadarDelivery(
    {
      kma: configuredKma(async (key) => {
        renderedKeys.push(key);
        if (key === KEYS[0]) {
          firstStarted.resolve();
          return releaseFirst.promise;
        }
        return Buffer.from(key);
      }),
    },
    { now: () => NOW, maxConcurrent: 1, maxQueued: 1, busyRetryAfterSeconds: 4 },
  );

  const first = delivery.frame(KEYS[0]);
  await firstStarted.promise;
  const queued = delivery.frame(KEYS[1]);

  assert.deepEqual(await delivery.frame(KEYS[2]), {
    kind: "busy",
    retryAfterSeconds: 4,
  });
  assert.deepEqual(renderedKeys, [KEYS[0]]);

  releaseFirst.resolve(Buffer.from(KEYS[0]));
  assertKind(await first, "ready");
  assertKind(await queued, "ready");
});

test("render capacity recovers after a KMA failure", async () => {
  let active = 0;
  let maxObserved = 0;
  const renderedKeys: string[] = [];
  const delivery = createRadarDelivery(
    {
      kma: configuredKma(async (key) => {
        active += 1;
        maxObserved = Math.max(maxObserved, active);
        renderedKeys.push(key);
        try {
          await nextTurn();
          if (key === KEYS[0]) throw new Error("upstream failed");
          return Buffer.from(key);
        } finally {
          active -= 1;
        }
      }),
    },
    { now: () => NOW, maxConcurrent: 1, maxQueued: 2 },
  );

  const [failed, recovered] = await Promise.all([
    delivery.frame(KEYS[0]),
    delivery.frame(KEYS[1]),
  ]);

  assert.deepEqual(failed, { kind: "unavailable" });
  assertKind(recovered, "ready");
  assert.equal(maxObserved, 1);
  assert.deepEqual(renderedKeys, [KEYS[0], KEYS[1]]);
});

test("render capacity recovers after a timeout", async () => {
  let renders = 0;
  const delivery = createRadarDelivery(
    {
      kma: configuredKma(async (key) => {
        renders += 1;
        if (key === KEYS[0]) throw new DOMException("timed out", "TimeoutError");
        return Buffer.from(key);
      }),
    },
    { now: () => NOW, maxConcurrent: 1, maxQueued: 1 },
  );

  const [timedOut, recovered] = await Promise.all([
    delivery.frame(KEYS[0]),
    delivery.frame(KEYS[1]),
  ]);

  assert.deepEqual(timedOut, { kind: "unavailable" });
  assertKind(recovered, "ready");
  assert.equal(renders, 2);
});

test("render capacity recovers after malformed radar data", async () => {
  let renders = 0;
  const delivery = createRadarDelivery(
    {
      kma: configuredKma(async (key) => {
        renders += 1;
        if (key === KEYS[0]) throw new RangeError("malformed grid");
        return Buffer.from(key);
      }),
    },
    { now: () => NOW, maxConcurrent: 1, maxQueued: 1 },
  );

  const [malformed, recovered] = await Promise.all([
    delivery.frame(KEYS[0]),
    delivery.frame(KEYS[1]),
  ]);

  assert.deepEqual(malformed, { kind: "unavailable" });
  assertKind(recovered, "ready");
  assert.equal(renders, 2);
});

test("active cancellation releases render capacity for queued work", async () => {
  const firstStarted = deferred<void>();
  let active = 0;
  let maxObserved = 0;
  const delivery = createRadarDelivery(
    {
      kma: configuredKma(async (key, signal) => {
        active += 1;
        maxObserved = Math.max(maxObserved, active);
        try {
          if (key !== KEYS[0]) return Buffer.from(key);
          firstStarted.resolve();
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          return Buffer.from("unreachable");
        } finally {
          active -= 1;
        }
      }),
    },
    { now: () => NOW, maxConcurrent: 1, maxQueued: 1 },
  );

  const controller = new AbortController();
  const cancelled = delivery.frame(KEYS[0], controller.signal);
  await firstStarted.promise;
  const queued = delivery.frame(KEYS[1]);
  controller.abort();

  assert.deepEqual(await cancelled, { kind: "cancelled" });
  assertKind(await queued, "ready");
  assert.equal(maxObserved, 1);
});

test("timeline probes through frame delivery and reuses its immutable cache", async () => {
  let renders = 0;
  let boundsReads = 0;
  const delivery = createRadarDelivery(
    {
      kma: {
        configured: () => true,
        bounds: async () => {
          boundsReads += 1;
          return BOUNDS;
        },
        render: async () => {
          renders += 1;
          return Buffer.from("newest-png");
        },
      },
    },
    { now: () => NOW, maxConcurrent: 2, maxQueued: 16 },
  );

  const timeline = await delivery.timeline();

  assert.equal(timeline.available, true);
  assert.deepEqual(timeline.frames.map((frame) => frame.t), KEYS);
  assert.deepEqual(timeline.frames.map((frame) => frame.time), [
    "2026-06-26T01:05:00.000Z",
    "2026-06-26T01:10:00.000Z",
    "2026-06-26T01:15:00.000Z",
    "2026-06-26T01:20:00.000Z",
    "2026-06-26T01:25:00.000Z",
    "2026-06-26T01:30:00.000Z",
    "2026-06-26T01:35:00.000Z",
    "2026-06-26T01:40:00.000Z",
    "2026-06-26T01:45:00.000Z",
    "2026-06-26T01:50:00.000Z",
    "2026-06-26T01:55:00.000Z",
    "2026-06-26T02:00:00.000Z",
    "2026-06-26T02:05:00.000Z",
  ]);
  assert.equal(timeline.frames.every((frame) => frame.nowcast === false), true);
  assert.equal(timeline.attribution, "기상청 (KMA)");
  assert.deepEqual(timeline.bounds, BOUNDS);
  assert.equal(renders, 1);
  assert.equal(boundsReads, 1);

  const cached = await delivery.frame(KEYS[12]);
  assertKind(cached, "ready");
  cached.png[0] = 0;
  const protectedCache = await delivery.frame(KEYS[12]);
  assertKind(protectedCache, "ready");
  assert.equal(protectedCache.png.toString(), "newest-png");
  assert.equal(renders, 1);
});

test("timeline scans backward only through not-yet-published frames and anchors all thirteen frames", async () => {
  const renderedKeys: string[] = [];
  const delivery = createRadarDelivery(
    {
      kma: configuredKma(async (key) => {
        renderedKeys.push(key);
        if (key === "202606261105" || key === "202606261100") {
          throw new KmaRadarSourceError("not-yet-published");
        }
        return Buffer.from(key);
      }),
    },
    { now: () => NOW, maxConcurrent: 1, maxQueued: 1 },
  );

  const timeline = await delivery.timeline();

  assert.equal(timeline.available, true);
  assert.deepEqual(renderedKeys, ["202606261105", "202606261100", "202606261055"]);
  assert.deepEqual(timeline.frames.map((candidate) => candidate.t), [
    "202606260955",
    "202606261000",
    "202606261005",
    "202606261010",
    "202606261015",
    "202606261020",
    "202606261025",
    "202606261030",
    "202606261035",
    "202606261040",
    "202606261045",
    "202606261050",
    "202606261055",
  ]);
});

test("timeline fallback is bounded by the oldest complete thirteen-frame window", async () => {
  const renderedKeys: string[] = [];
  const delivery = createRadarDelivery(
    {
      kma: configuredKma(async (key) => {
        renderedKeys.push(key);
        throw new KmaRadarSourceError("not-yet-published");
      }),
    },
    { now: () => NOW, maxConcurrent: 1, maxQueued: 1 },
  );

  assert.equal((await delivery.timeline()).available, false);
  assert.deepEqual(renderedKeys, [
    "202606261105",
    "202606261100",
    "202606261055",
    "202606261050",
    "202606261045",
    "202606261040",
    "202606261035",
  ]);
});

test("timeline does not scan backward after a terminal upstream failure", async () => {
  const renderedKeys: string[] = [];
  const delivery = createRadarDelivery(
    {
      kma: configuredKma(async (key) => {
        renderedKeys.push(key);
        throw new KmaRadarSourceError("terminal");
      }),
    },
    { now: () => NOW, maxConcurrent: 1, maxQueued: 1 },
  );

  assert.equal((await delivery.timeline()).available, false);
  assert.deepEqual(renderedKeys, ["202606261105"]);
});

test("timeline returns promptly when its nominal probe is busy", async () => {
  const held = deferred<Buffer>();
  const heldStarted = deferred<void>();
  const delivery = createRadarDelivery(
    {
      kma: configuredKma(async (key) => {
        if (key === KEYS[0]) {
          heldStarted.resolve();
          return held.promise;
        }
        return Buffer.from(key);
      }),
    },
    { now: () => NOW, maxConcurrent: 1, maxQueued: 0, busyRetryAfterSeconds: 6 },
  );

  const occupying = delivery.frame(KEYS[0]);
  await heldStarted.promise;
  const timeline = await delivery.timeline();

  assert.equal(timeline.available, false);
  held.resolve(Buffer.from(KEYS[0]));
  assertKind(await occupying, "ready");
});

test("timeline cancellation stops a fallback scan and releases capacity", async () => {
  const secondStarted = deferred<void>();
  const renderedKeys: string[] = [];
  const delivery = createRadarDelivery(
    {
      kma: configuredKma(async (key, signal) => {
        renderedKeys.push(key);
        if (key === KEYS[0]) return Buffer.from(key);
        if (renderedKeys.length === 1) throw new KmaRadarSourceError("not-yet-published");
        secondStarted.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return Buffer.from("unreachable");
      }),
    },
    { now: () => NOW, maxConcurrent: 1, maxQueued: 1 },
  );

  const controller = new AbortController();
  const timeline = delivery.timeline(controller.signal);
  await Promise.race([secondStarted.promise, timeline.then(() => undefined)]);
  controller.abort();

  assert.equal((await timeline).available, false);
  assert.deepEqual(renderedKeys, ["202606261105", "202606261100"]);
  assertKind(await delivery.frame(KEYS[0]), "ready");
});

test("timeline degrades to an honest empty state when KMA is not configured", async () => {
  let boundsReads = 0;
  let renders = 0;
  const delivery = createRadarDelivery(
    {
      kma: {
        configured: () => false,
        bounds: async () => {
          boundsReads += 1;
          return BOUNDS;
        },
        render: async () => {
          renders += 1;
          return Buffer.from("unexpected");
        },
      },
    },
    { now: () => NOW, maxConcurrent: 2, maxQueued: 16 },
  );

  assert.deepEqual(await delivery.timeline(), {
    available: false,
    frames: [],
    attribution: "기상청 (KMA)",
    bounds: null,
  });
  assert.deepEqual({ boundsReads, renders }, { boundsReads: 0, renders: 0 });
});

test("radar timeline route forwards the request signal to RadarDelivery", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const timeline: KmaRadarFrames = {
    available: false,
    frames: [],
    attribution: "기상청 (KMA)",
    bounds: null,
  };

  const request = new Request("https://raintoday.test/api/radar/frames", {
    signal: controller.signal,
  });
  const response = await deliverRadarTimeline(request, {
    timeline: async (signal) => {
      receivedSignal = signal;
      return timeline;
    },
  });

  assert.equal(receivedSignal, request.signal);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), timeline);
});

test("radar frame route maps delivery results to stable HTTP responses", async () => {
  const cases: Array<{
    result: RadarFrameResult;
    status: number;
    body: string | Uint8Array;
    cacheControl: string;
    retryAfter?: string;
  }> = [
    {
      result: { kind: "ready", png: Buffer.from([137, 80, 78, 71]) },
      status: 200,
      body: new Uint8Array([137, 80, 78, 71]),
      cacheControl: "public, max-age=86400, s-maxage=86400, immutable",
    },
    { result: { kind: "invalid" }, status: 400, body: "bad request", cacheControl: "no-store" },
    {
      result: { kind: "busy", retryAfterSeconds: 7 },
      status: 503,
      body: "radar busy",
      cacheControl: "no-store",
      retryAfter: "7",
    },
    { result: { kind: "cancelled" }, status: 499, body: "request cancelled", cacheControl: "no-store" },
    {
      result: { kind: "unavailable" },
      status: 502,
      body: "radar unavailable",
      cacheControl: "no-store",
    },
  ];
  for (const expected of cases) {
    const controller = new AbortController();
    let receivedKey: string | undefined;
    let receivedSignal: AbortSignal | undefined;
    const request = new Request("https://raintoday.test/api/radar/frame?t=202606261105", {
      signal: controller.signal,
    });
    const response = await deliverRadarFrame(request, {
      frame: async (key, signal) => {
        receivedKey = key;
        receivedSignal = signal;
        return expected.result;
      },
    });

    assert.equal(receivedKey, "202606261105");
    assert.equal(receivedSignal, request.signal);
    assert.equal(response.status, expected.status);
    assert.equal(response.headers.get("Cache-Control"), expected.cacheControl);
    assert.equal(response.headers.get("Retry-After"), expected.retryAfter ?? null);
    if (expected.body instanceof Uint8Array) {
      assert.equal(response.headers.get("Content-Type"), "image/png");
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), expected.body);
    } else {
      assert.equal(await response.text(), expected.body);
    }
  }
});
