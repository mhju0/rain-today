import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import {
  createRadarFrameLoader,
  type RadarDecodeImage,
  type RadarFrameLoaderOptions,
} from "./clientLoader.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush(turns = 3): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await nextTurn();
}

const frames = (...keys: string[]) => keys.map((t) => ({ t }));

function pngResponse(): Response {
  return new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }), {
    status: 200,
    headers: { "Content-Type": "image/png" },
  });
}

function controlledFetch() {
  interface Call {
    url: string;
    signal: AbortSignal;
    resolve(response: Response): void;
    reject(reason?: unknown): void;
  }

  const calls: Call[] = [];
  let active = 0;
  let maxActive = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    const response = deferred<Response>();
    active += 1;
    maxActive = Math.max(maxActive, active);
    const onAbort = () => response.reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    calls.push({
      url: String(input),
      signal,
      resolve: response.resolve,
      reject: response.reject,
    });
    try {
      return await response.promise;
    } finally {
      active -= 1;
      signal.removeEventListener("abort", onAbort);
    }
  }) as typeof fetch;

  return {
    calls,
    fetcher,
    get maxActive() {
      return maxActive;
    },
  };
}

function controlledImages() {
  const images: Array<{ image: RadarDecodeImage; decoded: ReturnType<typeof deferred<void>> }> = [];
  const createImage = () => {
    const decoded = deferred<void>();
    const image: RadarDecodeImage = {
      src: "",
      decode: () => decoded.promise,
    };
    images.push({ image, decoded });
    return image;
  };
  return { images, createImage };
}

function trackedUrls() {
  let nextUrl = 1;
  const revoked: string[] = [];
  return {
    revoked,
    createObjectURL: () => `blob:radar-${nextUrl++}`,
    revokeObjectURL: (url: string) => revoked.push(url),
  };
}

test("radar frame loader starts with no retained client state", () => {
  const loader = createRadarFrameLoader();

  assert.equal(loader.getSnapshot().size, 0);
  loader.dispose();
});

test("one loader owns fetch and decode across priority changes, refresh, failure, and unmount", async () => {
  const requests = controlledFetch();
  const imageHarness = controlledImages();
  const urls = trackedUrls();
  const loader = createRadarFrameLoader({
    fetcher: requests.fetcher,
    createImage: imageHarness.createImage,
    createObjectURL: urls.createObjectURL,
    revokeObjectURL: urls.revokeObjectURL,
  });
  const abc = frames("a", "b", "c");

  loader.update(abc, 0);
  assert.equal(requests.calls.length, 1);
  assert.match(requests.calls[0].url, /t=a$/);

  // Autoplay/priority movement aborts the obsolete active request before starting another.
  loader.update(abc, 1);
  assert.equal(requests.calls[0].signal.aborted, true);
  await flush();
  assert.match(requests.calls[1].url, /t=b$/);

  // A seek reprioritizes immediately and still keeps one network request at a time.
  loader.update(abc, 2);
  assert.equal(requests.calls[1].signal.aborted, true);
  await flush();
  assert.match(requests.calls[2].url, /t=c$/);
  requests.calls[2].resolve(pngResponse());
  await flush();
  assert.equal(imageHarness.images.length, 1);
  assert.equal(loader.getSnapshot().get("c")?.kind, "loading");
  assert.equal(requests.calls.length, 3, "decode retains the only progressive slot");

  // A refreshed timeline aborts decode, revokes its provisional URL, and starts at new active.
  loader.update(frames("d", "e"), 0);
  await flush();
  assert.equal(imageHarness.images[0].image.src, "");
  assert.deepEqual(urls.revoked, ["blob:radar-1"]);
  assert.match(requests.calls[3].url, /t=d$/);

  requests.calls[3].resolve(new Response(null, { status: 502 }));
  await flush();
  assert.deepEqual(loader.getSnapshot().get("d"), { kind: "failed" });
  assert.match(requests.calls[4].url, /t=e$/);

  loader.dispose();
  await flush();
  assert.equal(requests.calls[4].signal.aborted, true);
  assert.equal(requests.maxActive, 1);
  assert.equal(requests.calls.length, 5);
  assert.equal(loader.getSnapshot().size, 0);

  // A late decode settlement from the discarded generation cannot restore C.
  imageHarness.images[0].decoded.resolve();
  await flush();
  assert.equal(loader.getSnapshot().has("c"), false);
  assert.deepEqual(urls.revoked, ["blob:radar-1"]);
});

test("warming follows active, next playback, and remaining frame order after decode", async () => {
  const requests = controlledFetch();
  const imageHarness = controlledImages();
  const urls = trackedUrls();
  const loader = createRadarFrameLoader({
    fetcher: requests.fetcher,
    createImage: imageHarness.createImage,
    createObjectURL: urls.createObjectURL,
    revokeObjectURL: urls.revokeObjectURL,
  });

  loader.update(frames("a", "b", "c"), 1);
  assert.equal(requests.calls.length, 1);
  assert.match(requests.calls[0].url, /t=b$/);
  requests.calls[0].resolve(pngResponse());
  await flush();
  assert.equal(requests.calls.length, 1);
  imageHarness.images[0].decoded.resolve();
  await flush();
  assert.match(requests.calls[1].url, /t=c$/);

  requests.calls[1].resolve(pngResponse());
  await flush();
  imageHarness.images[1].decoded.resolve();
  await flush();
  assert.match(requests.calls[2].url, /t=a$/);
  loader.dispose();
});

test("503 and 429 honor bounded Retry-After delays without becoming terminal failures", async () => {
  const responses = [
    new Response(null, { status: 503, headers: { "Retry-After": "2" } }),
    new Response(null, { status: 429, headers: { "Retry-After": "120" } }),
    pngResponse(),
  ];
  const delays: number[] = [];
  let fetches = 0;
  const loader = createRadarFrameLoader({
    fetcher: (async () => {
      fetches += 1;
      return responses.shift()!;
    }) as typeof fetch,
    createImage: () => ({ src: "", decode: async () => undefined }),
    createObjectURL: () => "blob:ready",
    revokeObjectURL: () => undefined,
    wait: async (delayMs) => {
      delays.push(delayMs);
    },
    maxAttempts: 3,
    maxRetryDelayMs: 60_000,
  });

  loader.update(frames("active"), 0);
  await flush(8);

  assert.equal(fetches, 3);
  assert.deepEqual(delays, [2_000, 60_000]);
  assert.deepEqual(loader.getSnapshot().get("active"), {
    kind: "ready",
    src: "blob:ready",
  });
  loader.dispose();
});

test("exhausted transient retries remain retryable instead of marking the frame failed", async () => {
  let fetches = 0;
  const loader = createRadarFrameLoader({
    fetcher: (async () => {
      fetches += 1;
      return new Response(null, { status: 503 });
    }) as typeof fetch,
    wait: async () => undefined,
    maxAttempts: 3,
    maxReentries: 1,
    baseRetryDelayMs: 100,
  });

  loader.update(frames("active"), 0);
  await flush(8);

  assert.equal(fetches, 6);
  assert.deepEqual(loader.getSnapshot().get("active"), {
    kind: "deferred",
    retryScheduled: false,
  });

  loader.retry();
  await flush(8);
  assert.equal(fetches, 12);
  assert.deepEqual(loader.getSnapshot().get("active"), {
    kind: "deferred",
    retryScheduled: false,
  });
  loader.dispose();
});

test("a bounded re-entry batch recovers from admission pressure without a timeline refresh", async () => {
  const responses = [
    new Response(null, { status: 503 }),
    new Response(null, { status: 503 }),
    new Response(null, { status: 503, headers: { "Retry-After": "10" } }),
    pngResponse(),
  ];
  const delays: number[] = [];
  const loader = createRadarFrameLoader({
    fetcher: (async () => responses.shift()!) as typeof fetch,
    createImage: () => ({ src: "", decode: async () => undefined }),
    createObjectURL: () => "blob:recovered",
    revokeObjectURL: () => undefined,
    wait: async (delayMs) => {
      delays.push(delayMs);
    },
    maxAttempts: 3,
    maxReentries: 1,
    baseRetryDelayMs: 100,
    reentryDelayMs: 5_000,
  });

  loader.update(frames("active"), 0);
  await flush(10);

  assert.deepEqual(delays, [100, 200, 10_000]);
  assert.deepEqual(loader.getSnapshot().get("active"), {
    kind: "ready",
    src: "blob:recovered",
  });
  loader.dispose();
});

test("unmount aborts a Retry-After wait and prevents another request", async () => {
  const waiting = deferred<void>();
  let waitSignal: AbortSignal | undefined;
  let fetches = 0;
  const loader = createRadarFrameLoader({
    fetcher: (async () => {
      fetches += 1;
      return new Response(null, { status: 503, headers: { "Retry-After": "10" } });
    }) as typeof fetch,
    wait: async (_delayMs, signal) => {
      waitSignal = signal;
      signal.addEventListener("abort", () => waiting.reject(signal.reason), { once: true });
      return waiting.promise;
    },
  });

  loader.update(frames("active"), 0);
  await flush();
  assert.ok(waitSignal);
  loader.dispose();
  await flush();

  assert.equal(waitSignal.aborted, true);
  assert.equal(fetches, 1);
  assert.equal(loader.getSnapshot().size, 0);
});

test("unmount cancels a scheduled re-entry after the bounded attempt batch", async () => {
  const scheduled = deferred<void>();
  let waitCalls = 0;
  let scheduledSignal: AbortSignal | undefined;
  let fetches = 0;
  const loader = createRadarFrameLoader({
    fetcher: (async () => {
      fetches += 1;
      return new Response(null, { status: 503 });
    }) as typeof fetch,
    wait: async (_delayMs, signal) => {
      waitCalls += 1;
      if (waitCalls < 3) return;
      scheduledSignal = signal;
      signal.addEventListener("abort", () => scheduled.reject(signal.reason), { once: true });
      return scheduled.promise;
    },
    maxAttempts: 3,
    maxReentries: 1,
  });

  loader.update(frames("active"), 0);
  await flush(8);
  assert.equal(fetches, 3);
  assert.ok(scheduledSignal);

  loader.dispose();
  await flush();
  assert.equal(scheduledSignal.aborted, true);
  assert.equal(fetches, 3);
});

test("Retry-After HTTP dates are clamped for future and past instants", async () => {
  const responses = [
    new Response(null, {
      status: 503,
      headers: { "Retry-After": new Date(Date.now() + 120_000).toUTCString() },
    }),
    new Response(null, {
      status: 503,
      headers: { "Retry-After": new Date(Date.now() - 120_000).toUTCString() },
    }),
    pngResponse(),
  ];
  const delays: number[] = [];
  const loader = createRadarFrameLoader({
    fetcher: (async () => responses.shift()!) as typeof fetch,
    createImage: () => ({ src: "", decode: async () => undefined }),
    createObjectURL: () => "blob:date-ready",
    revokeObjectURL: () => undefined,
    wait: async (delayMs) => {
      delays.push(delayMs);
    },
    maxAttempts: 3,
    maxRetryDelayMs: 60_000,
  });

  loader.update(frames("active"), 0);
  await flush(8);

  assert.deepEqual(delays, [60_000, 0]);
  assert.equal(loader.getSnapshot().get("active")?.kind, "ready");
  loader.dispose();
});

test("decode and visible-image failures are terminal and revoke only their owned URLs", async () => {
  const responses = [pngResponse(), pngResponse()];
  const decodeError = new DOMException("bad image", "EncodingError");
  let imageNumber = 0;
  const urls = trackedUrls();
  const options: RadarFrameLoaderOptions = {
    fetcher: (async () => responses.shift()!) as typeof fetch,
    createImage: () => {
      imageNumber += 1;
      return {
        src: "",
        decode: imageNumber === 1 ? async () => Promise.reject(decodeError) : async () => undefined,
      };
    },
    createObjectURL: urls.createObjectURL,
    revokeObjectURL: urls.revokeObjectURL,
  };
  const loader = createRadarFrameLoader(options);

  loader.update(frames("a", "b"), 0);
  await flush(8);
  assert.deepEqual(loader.getSnapshot().get("a"), { kind: "failed" });
  assert.deepEqual(loader.getSnapshot().get("b"), {
    kind: "ready",
    src: "blob:radar-2",
  });
  assert.deepEqual(urls.revoked, ["blob:radar-1"]);

  loader.reportVisibleError("b", "blob:stale");
  assert.equal(loader.getSnapshot().get("b")?.kind, "ready");
  loader.reportVisibleError("b", "blob:radar-2");
  assert.deepEqual(loader.getSnapshot().get("b"), { kind: "failed" });
  assert.deepEqual(urls.revoked, ["blob:radar-1", "blob:radar-2"]);

  loader.dispose();
  assert.deepEqual(urls.revoked, ["blob:radar-1", "blob:radar-2"]);
});
