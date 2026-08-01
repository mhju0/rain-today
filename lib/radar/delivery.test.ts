import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import {
  createRadarDelivery,
  type RadarDeliveryDependencies,
  type RadarFrameResult,
} from "./delivery.ts";

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
    { now: () => NOW, maxConcurrent: 1, maxQueued: 1 },
  );

  const first = delivery.frame(KEYS[0]);
  await firstStarted.promise;
  const queued = delivery.frame(KEYS[1]);

  assert.deepEqual(await delivery.frame(KEYS[2]), { kind: "busy" });
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
