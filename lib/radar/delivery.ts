import type { KmaRadarFrame, KmaRadarFrames, RadarBounds } from "../types.ts";
import { productionKmaRadarAdapter } from "./apihub.ts";

const FRAME_STEP_MIN = 5;
const FRAME_COUNT = 13;
const PUBLISH_LAG_MIN = 7;
const MAX_FRAME_AGE_MIN = 90;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_QUEUED = 8;

const BUSY = Symbol("radar delivery busy");
const CANCELLED = Symbol("radar delivery cancelled");

export const KMA_RADAR_ATTRIBUTION = "기상청 (KMA)";

export interface KmaRadarAdapter {
  configured(): boolean;
  bounds(signal?: AbortSignal): Promise<RadarBounds>;
  render(key: string, signal?: AbortSignal): Promise<Buffer>;
}

export interface RadarDeliveryDependencies {
  kma: KmaRadarAdapter;
}

export interface RadarDeliveryOptions {
  now?: () => number;
  maxConcurrent?: number;
  maxQueued?: number;
}

export type RadarFrameResult =
  | { kind: "ready"; png: Buffer }
  | { kind: "invalid" }
  | { kind: "busy" }
  | { kind: "cancelled" }
  | { kind: "unavailable" };

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
  promise: Promise<RadarFrameResult>;
  subscribers: number;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The latest five-minute boundary at or before the KMA publication lag, KST-shifted. */
export function latestFrameInstant(nowMs = Date.now()): Date {
  const stepMs = FRAME_STEP_MIN * 60_000;
  const kstMs = nowMs + 9 * 3600_000 - PUBLISH_LAG_MIN * 60_000;
  return new Date(Math.floor(kstMs / stepMs) * stepMs);
}

/** yyyyMMddHHmm (KST) key for a KST-shifted Date. */
export function frameKey(kst: Date): string {
  return (
    `${kst.getUTCFullYear()}${pad(kst.getUTCMonth() + 1)}${pad(kst.getUTCDate())}` +
    `${pad(kst.getUTCHours())}${pad(kst.getUTCMinutes())}`
  );
}

/** True ISO instant (UTC) for a KST yyyyMMddHHmm key. */
export function frameKeyToIso(key: string): string {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(4, 6)) - 1;
  const day = Number(key.slice(6, 8));
  const hour = Number(key.slice(8, 10));
  const minute = Number(key.slice(10, 12));
  return new Date(Date.UTC(year, month, day, hour, minute) - 9 * 3600_000).toISOString();
}

/** A real calendar instant aligned to the KMA five-minute frame cadence. */
export function isValidFrameKey(key: string): boolean {
  if (!/^\d{12}$/.test(key)) return false;
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(4, 6));
  const day = Number(key.slice(6, 8));
  const hour = Number(key.slice(8, 10));
  const minute = Number(key.slice(10, 12));
  if (minute % FRAME_STEP_MIN !== 0) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour &&
    parsed.getUTCMinutes() === minute
  );
}

/** Restrict expensive KMA work to the recent observed playback window. */
export function isAllowedFrameKey(key: string, nowMs = Date.now()): boolean {
  if (!isValidFrameKey(key)) return false;
  const frameMs = Date.UTC(
    Number(key.slice(0, 4)),
    Number(key.slice(4, 6)) - 1,
    Number(key.slice(6, 8)),
    Number(key.slice(8, 10)),
    Number(key.slice(10, 12)),
  );
  const newestMs = latestFrameInstant(nowMs).getTime();
  return frameMs <= newestMs && frameMs >= newestMs - MAX_FRAME_AGE_MIN * 60_000;
}

function emptyTimeline(): KmaRadarFrames {
  return {
    available: false,
    frames: [],
    attribution: KMA_RADAR_ATTRIBUTION,
    bounds: null,
  };
}

function cloneResult(result: RadarFrameResult): RadarFrameResult {
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

  async function executeRender(key: string, signal: AbortSignal): Promise<RadarFrameResult> {
    try {
      const png = await admitted(signal, async () => {
        const rendered = await dependencies.kma.render(key, signal);
        signal.throwIfAborted();
        return rendered;
      });
      const immutablePng = Buffer.from(png);
      cache.set(key, immutablePng);
      return { kind: "ready", png: immutablePng };
    } catch (error) {
      if (error === BUSY) return { kind: "busy" };
      if (error === CANCELLED || signal.aborted) return { kind: "cancelled" };
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
  ): Promise<RadarFrameResult> {
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

    return new Promise<RadarFrameResult>((resolve) => {
      let settled = false;
      const settle = (result: RadarFrameResult, aborted: boolean) => {
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

  async function frame(key: string, signal?: AbortSignal): Promise<RadarFrameResult> {
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

  async function timeline(signal?: AbortSignal): Promise<KmaRadarFrames> {
    if (signal?.aborted) return emptyTimeline();
    const newest = latestFrameInstant(now());
    const newestKey = frameKey(newest);
    const probe = await frame(newestKey, signal);
    if (probe.kind !== "ready" || signal?.aborted) return emptyTimeline();

    let bounds: RadarBounds;
    try {
      bounds = await dependencies.kma.bounds(signal);
      if (signal?.aborted) return emptyTimeline();
    } catch {
      return emptyTimeline();
    }

    const frames: KmaRadarFrame[] = [];
    for (let i = FRAME_COUNT - 1; i >= 0; i -= 1) {
      const instant = new Date(newest.getTime() - i * FRAME_STEP_MIN * 60_000);
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
