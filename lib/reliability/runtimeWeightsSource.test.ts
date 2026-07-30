import assert from "node:assert/strict";
import test from "node:test";
import { clearCache } from "../cache.ts";
import type { WeightsState } from "./types.ts";
import {
  createHttpWeightsStateReader,
  createRuntimeWeightsLoader,
} from "./runtimeWeightsSource.ts";

const validState: WeightsState = {
  updatedAt: "2026-07-10T21:13:00.000Z",
  eventsScored: 51,
  processedDates: ["2026-07-09", "2026-07-10"],
  weights: { "open-meteo": 0.6, kma: 0.4 },
};

function fetchReturning(response: Response): typeof fetch {
  return (async () => response) as typeof fetch;
}

test("runtime weight loader reads schema-valid learned state from durable HTTP storage", async () => {
  const key = "runtime-weights-source-valid";
  clearCache(key);
  const reader = createHttpWeightsStateReader({
    url: "https://state.example/source-weights.json",
    fetcher: fetchReturning(Response.json(validState)),
  });

  const load = createRuntimeWeightsLoader(reader, { cacheKey: key, ttlMs: 60_000 });
  assert.deepEqual(await load(), validState);
});

test("runtime weight loader safely falls back for unavailable or malformed remote state", async () => {
  for (const [suffix, response] of [
    ["missing", new Response("missing", { status: 404 })],
    ["malformed", Response.json({ ...validState, weights: { kma: -1 } })],
  ] as const) {
    const key = `runtime-weights-source-${suffix}`;
    clearCache(key);
    const reader = createHttpWeightsStateReader({
      url: "https://state.example/source-weights.json",
      fetcher: fetchReturning(response),
    });
    const load = createRuntimeWeightsLoader(reader, { cacheKey: key, ttlMs: 60_000 });
    assert.equal(await load(), null);
  }
});

test("runtime weight reader rejects non-HTTPS and private-network URLs before fetching", async () => {
  for (const url of ["http://state.example/weights.json", "https://127.0.0.1/weights.json"]) {
    let fetched = false;
    const reader = createHttpWeightsStateReader({
      url,
      fetcher: (async () => {
        fetched = true;
        return Response.json(validState);
      }) as typeof fetch,
    });
    assert.equal(await reader.read(), null);
    assert.equal(fetched, false);
  }
});

test("runtime weight loader keeps the last good state when a refresh is invalid", async () => {
  const key = "runtime-weights-source-last-good";
  clearCache(key);
  let reads = 0;
  const reader = {
    async read() {
      reads += 1;
      return reads === 1 ? validState : null;
    },
  };
  const load = createRuntimeWeightsLoader(reader, { cacheKey: key, ttlMs: 0 });

  assert.deepEqual(await load(), validState);
  assert.deepEqual(await load(), validState);
});
