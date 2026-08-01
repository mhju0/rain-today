import type { KmaRadarFrame, KmaRadarFrames, RadarBounds } from "../types.ts";
import { productionKmaRadarAdapter } from "./apihub.ts";
import {
  frameKey,
  frameKeyToIso,
  isAllowedFrameKey,
  type KmaRadarAdapter,
  KMA_RADAR_ATTRIBUTION,
  KmaRadarSourceError,
  latestFrameInstant,
  RADAR_FRAME_STEP_MINUTES,
  RADAR_MAX_FRAME_AGE_MINUTES,
} from "./kma.ts";

const FRAME_COUNT = 13;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_QUEUED = 8;
const DEFAULT_BUSY_RETRY_AFTER_SECONDS = 1;
const MAX_TIMELINE_FALLBACK_STEPS = Math.floor(
  (RADAR_MAX_FRAME_AGE_MINUTES - (FRAME_COUNT - 1) * RADAR_FRAME_STEP_MINUTES) /
    RADAR_FRAME_STEP_MINUTES,
);

const BUSY = Symbol("radar delivery busy");
const CANCELLED = Symbol("radar delivery cancelled");

export interface RadarDeliveryDependencies {
  kma: KmaRadarAdapter;
}

export interface RadarDeliveryOptions {
  now?: () => number;
  maxConcurrent?: number;
  maxQueued?: number;
  busyRetryAfterSeconds?: number;
}

export type RadarFrameResult =
  | { kind: "ready"; png: Buffer }
  | { kind: "invalid" }
  | { kind: "busy"; retryAfterSeconds: number }
  | { kind: "cancelled" }
  | { kind: "unavailable" };

type InternalRadarFrameResult = RadarFrameResult | { kind: "not-yet-published" };

export interface RadarDelivery {
  timeline(signal?: AbortSignal): Promise<KmaRadarFrames>;
  frame(key: string, signal?: AbortSignal): Promise<RadarFrameResult>;
}

interface QueueEntry {
  signal: AbortSignal;
  resolve: () => void;
  reject: (reason: typeof CANCELLED) => void;
  removeAbortListener: () => void;
}

interface PendingRender {
  controller: AbortController;
  promise: Promise<InternalRadarFrameResult>;
  subscribers: number;
}

function emptyTimeline(): KmaRadarFrames {
  return {
    available: false,
    frames: [],
    attribution: KMA_RADAR_ATTRIBUTION,
    bounds: null,
  };
}

function cloneResult(result: InternalRadarFrameResult): InternalRadarFrameResult {
  return result.kind === "ready" ? { kind: "ready", png: Buffer.from(result.png) } : result;
}

function requiredInteger(value: number, name: string, minimum: number): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

export function createRadarDelivery(
  dependencies: RadarDeliveryDependencies,
  options: RadarDeliveryOptions = {},
): RadarDelivery {
  const now = options.now ?? Date.now;
  const maxConcurrent = requiredInteger(
    options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    "maxConcurrent",
    1,
  );
  const maxQueued = requiredInteger(options.maxQueued ?? DEFAULT_MAX_QUEUED, "maxQueued", 0);
  const busyRetryAfterSeconds = requiredInteger(
    options.busyRetryAfterSeconds ?? DEFAULT_BUSY_RETRY_AFTER_SECONDS,
    "busyRetryAfterSeconds",
    1,
  );
  const cache = new Map<string, Buffer>();
  const pending = new Map<string, PendingRender>();
  const queue: QueueEntry[] = [];
  let active = 0;

  function release(): void {
    active -= 1;
    while (queue.length > 0) {
      const next = queue.shift()!;
      next.removeAbortListener();
      if (next.signal.aborted) {
        next.reject(CANCELLED);
        continue;
      }
      active += 1;
      next.resolve();
      return;
    }
  }

  async function acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw CANCELLED;
    if (active < maxConcurrent) {
      active += 1;
      return;
    }
    if (queue.length >= maxQueued) throw BUSY;

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = queue.indexOf(entry);
        if (index < 0) return;
        queue.splice(index, 1);
        entry.removeAbortListener();
        reject(CANCELLED);
      };
      const entry: QueueEntry = {
        signal,
        resolve,
        reject,
        removeAbortListener: () => signal.removeEventListener("abort", onAbort),
      };
      queue.push(entry);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function admitted<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    await acquire(signal);
    try {
      return await work();
    } finally {
      release();
    }
  }

  function pruneCache(nowMs: number): void {
    for (const key of cache.keys()) {
      if (!isAllowedFrameKey(key, nowMs)) cache.delete(key);
    }
  }

  async function executeRender(
    key: string,
    signal: AbortSignal,
  ): Promise<InternalRadarFrameResult> {
    try {
      const png = await admitted(signal, async () => {
        const rendered = await dependencies.kma.render(key, signal);
        signal.throwIfAborted();
        return rendered;
      });
      signal.throwIfAborted();
      const immutablePng = Buffer.from(png);
      cache.set(key, immutablePng);
      return { kind: "ready", png: immutablePng };
    } catch (error) {
      if (error === BUSY) return { kind: "busy", retryAfterSeconds: busyRetryAfterSeconds };
      if (error === CANCELLED || signal.aborted) return { kind: "cancelled" };
      if (
        error instanceof KmaRadarSourceError &&
        error.kind === "not-yet-published"
      ) {
        return { kind: "not-yet-published" };
      }
      return { kind: "unavailable" };
    }
  }

  function startRender(key: string): PendingRender {
    const controller = new AbortController();
    const promise = executeRender(key, controller.signal).finally(() => {
      if (pending.get(key)?.controller === controller) pending.delete(key);
    });
    const work = { controller, promise, subscribers: 0 };
    pending.set(key, work);
    return work;
  }

  function releaseSubscriber(work: PendingRender, aborted: boolean): void {
    work.subscribers -= 1;
    if (aborted && work.subscribers === 0) work.controller.abort();
  }

  async function subscribe(
    work: PendingRender,
    signal?: AbortSignal,
  ): Promise<InternalRadarFrameResult> {
    work.subscribers += 1;
    if (!signal) {
      try {
        return cloneResult(await work.promise);
      } finally {
        releaseSubscriber(work, false);
      }
    }
    if (signal.aborted) {
      releaseSubscriber(work, true);
      return { kind: "cancelled" };
    }

    return new Promise<InternalRadarFrameResult>((resolve) => {
      let settled = false;
      const settle = (result: InternalRadarFrameResult, aborted: boolean) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        releaseSubscriber(work, aborted);
        resolve(cloneResult(result));
      };
      const onAbort = () => settle({ kind: "cancelled" }, true);
      signal.addEventListener("abort", onAbort, { once: true });
      void work.promise.then(
        (result) => settle(result, false),
        () => settle({ kind: "unavailable" }, false),
      );
    });
  }

  async function loadFrame(
    key: string,
    signal?: AbortSignal,
  ): Promise<InternalRadarFrameResult> {
    const nowMs = now();
    if (!isAllowedFrameKey(key, nowMs)) return { kind: "invalid" };
    if (signal?.aborted) return { kind: "cancelled" };
    pruneCache(nowMs);

    const cached = cache.get(key);
    if (cached) return { kind: "ready", png: Buffer.from(cached) };

    const inFlight = pending.get(key);
    if (inFlight && !inFlight.controller.signal.aborted) return subscribe(inFlight, signal);
    if (inFlight) pending.delete(key);

    try {
      if (!dependencies.kma.configured()) return { kind: "unavailable" };
    } catch {
      return { kind: "unavailable" };
    }
    return subscribe(startRender(key), signal);
  }

  async function frame(key: string, signal?: AbortSignal): Promise<RadarFrameResult> {
    const result = await loadFrame(key, signal);
    return result.kind === "not-yet-published" ? { kind: "unavailable" } : result;
  }

  async function timeline(signal?: AbortSignal): Promise<KmaRadarFrames> {
    if (signal?.aborted) return emptyTimeline();
    const nominalNewest = latestFrameInstant(now());
    let newest: Date | null = null;

    for (let step = 0; step <= MAX_TIMELINE_FALLBACK_STEPS; step += 1) {
      if (signal?.aborted) return emptyTimeline();
      const candidate = new Date(
        nominalNewest.getTime() - step * RADAR_FRAME_STEP_MINUTES * 60_000,
      );
      const probe = await loadFrame(frameKey(candidate), signal);
      if (probe.kind === "ready") {
        newest = candidate;
        break;
      }
      if (probe.kind !== "not-yet-published") return emptyTimeline();
    }
    if (!newest || signal?.aborted) return emptyTimeline();

    let bounds: RadarBounds;
    try {
      bounds = await dependencies.kma.bounds(signal);
      if (signal?.aborted) return emptyTimeline();
    } catch {
      return emptyTimeline();
    }

    const frames: KmaRadarFrame[] = [];
    for (let i = FRAME_COUNT - 1; i >= 0; i -= 1) {
      const instant = new Date(
        newest.getTime() - i * RADAR_FRAME_STEP_MINUTES * 60_000,
      );
      const key = frameKey(instant);
      frames.push({ t: key, time: frameKeyToIso(key), nowcast: false });
    }
    return {
      available: true,
      frames,
      attribution: KMA_RADAR_ATTRIBUTION,
      bounds,
    };
  }

  return { timeline, frame };
}

export const productionRadarDelivery = createRadarDelivery({
  kma: productionKmaRadarAdapter,
});
