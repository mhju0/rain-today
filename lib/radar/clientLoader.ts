import type { KmaRadarFrame } from "../types.ts";
import { orderedRadarWarmup } from "./presentation.ts";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_REENTRIES = 1;
const DEFAULT_BASE_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_REENTRY_DELAY_MS = 5_000;

export type RadarClientFrameState =
  | { kind: "idle" }
  | { kind: "loading"; attempt: number }
  | { kind: "ready"; src: string }
  | { kind: "deferred"; retryScheduled: boolean }
  | { kind: "failed" };

export interface RadarDecodeImage {
  src: string;
  decode(): Promise<void>;
}

export interface RadarFrameLoaderOptions {
  fetcher?: typeof fetch;
  createImage?: () => RadarDecodeImage;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  maxAttempts?: number;
  maxReentries?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  reentryDelayMs?: number;
}

export interface RadarFrameLoader {
  update(frames: readonly Pick<KmaRadarFrame, "t">[], activeIndex: number): void;
  getSnapshot(): ReadonlyMap<string, RadarClientFrameState>;
  subscribe(listener: (snapshot: ReadonlyMap<string, RadarClientFrameState>) => void): () => void;
  reportVisibleError(key: string, src: string): void;
  retry(): void;
  dispose(): void;
}

interface OwnedUrl {
  src: string;
  revoked: boolean;
}

interface LoadedFrame {
  image: RadarDecodeImage;
  url: OwnedUrl;
}

interface LoadTask {
  key: string;
  controller: AbortController;
  image: RadarDecodeImage | null;
  provisionalUrl: OwnedUrl | null;
}

interface ScheduledRetry {
  key: string;
  controller: AbortController;
}

type LoadOutcome =
  | { kind: "ready"; image: RadarDecodeImage; url: OwnedUrl }
  | { kind: "terminal" }
  | { kind: "transient"; retryAfterMs: number }
  | { kind: "aborted" };

function requiredPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function requiredNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number >= 0`);
  }
  return value;
}

function requiredNonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be an integer >= 0`);
  }
  return value;
}

function abortableWait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => settle(resolve), delayMs);
    const onAbort = () => settle(() => reject(signal.reason));
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      finish();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForPromise<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => settle(() => reject(signal.reason));
    const settle = (finish: () => void) => {
      signal.removeEventListener("abort", onAbort);
      finish();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === "AbortError");
}

function parseRetryAfterMs(value: string | null, maxDelayMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.min(maxDelayMs, Math.max(0, Number(trimmed) * 1_000));
  }
  const instant = Date.parse(trimmed);
  if (!Number.isFinite(instant)) return null;
  return Math.min(maxDelayMs, Math.max(0, instant - Date.now()));
}

function isBackpressureStatus(status: number): boolean {
  return status === 429 || status === 503;
}

export function createRadarFrameLoader(
  options: RadarFrameLoaderOptions = {},
): RadarFrameLoader {
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const createImage = options.createImage ?? (() => new Image());
  const createObjectURL = options.createObjectURL ?? ((blob) => URL.createObjectURL(blob));
  const revokeObjectURL = options.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url));
  const wait = options.wait ?? abortableWait;
  const maxAttempts = requiredPositiveInteger(
    options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    "maxAttempts",
  );
  const maxReentries = requiredNonNegativeInteger(
    options.maxReentries ?? DEFAULT_MAX_REENTRIES,
    "maxReentries",
  );
  const baseRetryDelayMs = requiredNonNegative(
    options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS,
    "baseRetryDelayMs",
  );
  const maxRetryDelayMs = requiredNonNegative(
    options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
    "maxRetryDelayMs",
  );
  const reentryDelayMs = Math.min(
    maxRetryDelayMs,
    requiredNonNegative(
      options.reentryDelayMs ?? DEFAULT_REENTRY_DELAY_MS,
      "reentryDelayMs",
    ),
  );

  const states = new Map<string, RadarClientFrameState>();
  const loaded = new Map<string, LoadedFrame>();
  const deferred = new Set<string>();
  const reentryCounts = new Map<string, number>();
  const listeners = new Set<
    (snapshot: ReadonlyMap<string, RadarClientFrameState>) => void
  >();
  let timelineKeys: string[] = [];
  let priority: string[] = [];
  let current: LoadTask | null = null;
  let scheduledRetry: ScheduledRetry | null = null;
  let disposed = false;

  function snapshot(): ReadonlyMap<string, RadarClientFrameState> {
    return new Map(states);
  }

  function emit(): void {
    const next = snapshot();
    for (const listener of listeners) listener(next);
  }

  function revoke(url: OwnedUrl): void {
    if (url.revoked) return;
    url.revoked = true;
    revokeObjectURL(url.src);
  }

  function releaseLoaded(key: string): void {
    const entry = loaded.get(key);
    if (!entry) return;
    loaded.delete(key);
    entry.image.src = "";
    revoke(entry.url);
  }

  function releaseProvisional(task: LoadTask): void {
    if (task.image) task.image.src = "";
    if (task.provisionalUrl) revoke(task.provisionalUrl);
    task.image = null;
    task.provisionalUrl = null;
  }

  function nextCandidate(): string | null {
    for (const key of priority) {
      const state = states.get(key);
      if (state?.kind === "ready" || state?.kind === "failed") continue;
      if (deferred.has(key)) return null;
      return key;
    }
    return null;
  }

  function abortCurrent(): void {
    if (!current || current.controller.signal.aborted) return;
    current.controller.abort();
    releaseProvisional(current);
  }

  function cancelScheduledRetry(notify = true): void {
    const scheduled = scheduledRetry;
    if (!scheduled) return;
    scheduledRetry = null;
    scheduled.controller.abort();
    const state = states.get(scheduled.key);
    if (state?.kind === "deferred" && state.retryScheduled) {
      states.set(scheduled.key, { kind: "deferred", retryScheduled: false });
      if (notify) emit();
    }
  }

  function canScheduleReentry(key: string): boolean {
    return (reentryCounts.get(key) ?? 0) < maxReentries;
  }

  function scheduleReentry(key: string, delayMs: number): void {
    cancelScheduledRetry();
    reentryCounts.set(key, (reentryCounts.get(key) ?? 0) + 1);
    const scheduled: ScheduledRetry = { key, controller: new AbortController() };
    scheduledRetry = scheduled;

    void wait(Math.max(reentryDelayMs, delayMs), scheduled.controller.signal).then(
      () => {
        if (scheduledRetry !== scheduled) return;
        scheduledRetry = null;
        if (disposed || !states.has(key) || !deferred.has(key)) return;
        deferred.delete(key);
        states.set(key, { kind: "idle" });
        emit();
        pump();
      },
      () => {
        if (scheduledRetry !== scheduled) return;
        scheduledRetry = null;
        if (disposed) return;
        const state = states.get(key);
        if (state?.kind === "deferred" && state.retryScheduled) {
          states.set(key, { kind: "deferred", retryScheduled: false });
          emit();
        }
      },
    );
  }

  function retryDelay(response: Response | null, attempt: number): number {
    const fromHeader = parseRetryAfterMs(
      response?.headers.get("Retry-After") ?? null,
      maxRetryDelayMs,
    );
    if (fromHeader !== null) return fromHeader;
    return Math.min(maxRetryDelayMs, baseRetryDelayMs * 2 ** (attempt - 1));
  }

  async function run(task: LoadTask): Promise<LoadOutcome> {
    const { signal } = task.controller;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (signal.aborted) return { kind: "aborted" };
      if (states.has(task.key)) {
        states.set(task.key, { kind: "loading", attempt });
        emit();
      }

      let response: Response | null = null;
      try {
        response = await fetcher(`/api/radar/frame?t=${encodeURIComponent(task.key)}`, {
          signal,
          cache: "force-cache",
        });
      } catch (error) {
        if (isAbort(error, signal)) return { kind: "aborted" };
        if (attempt === maxAttempts) {
          return { kind: "transient", retryAfterMs: retryDelay(null, attempt) };
        }
      }

      if (response && !isBackpressureStatus(response.status)) {
        if (!response.ok) return { kind: "terminal" };
        const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim();
        if (contentType !== "image/png") return { kind: "terminal" };

        try {
          const blob = await waitForPromise(response.blob(), signal);
          signal.throwIfAborted();
          const url: OwnedUrl = { src: createObjectURL(blob), revoked: false };
          task.provisionalUrl = url;
          const image = createImage();
          task.image = image;
          image.src = url.src;
          await waitForPromise(image.decode(), signal);
          signal.throwIfAborted();
          task.image = null;
          task.provisionalUrl = null;
          return { kind: "ready", image, url };
        } catch (error) {
          releaseProvisional(task);
          return isAbort(error, signal) ? { kind: "aborted" } : { kind: "terminal" };
        }
      }

      if (attempt === maxAttempts) {
        return { kind: "transient", retryAfterMs: retryDelay(response, attempt) };
      }
      try {
        await wait(retryDelay(response, attempt), signal);
      } catch (error) {
        return isAbort(error, signal)
          ? { kind: "aborted" }
          : { kind: "transient", retryAfterMs: retryDelay(response, attempt) };
      }
    }

    return { kind: "transient", retryAfterMs: reentryDelayMs };
  }

  function finish(task: LoadTask, outcome: LoadOutcome): void {
    if (current !== task) {
      if (outcome.kind === "ready") {
        outcome.image.src = "";
        revoke(outcome.url);
      }
      releaseProvisional(task);
      return;
    }
    current = null;

    if (disposed || !states.has(task.key)) {
      if (outcome.kind === "ready") {
        outcome.image.src = "";
        revoke(outcome.url);
      }
      releaseProvisional(task);
      if (!disposed) pump();
      return;
    }

    switch (outcome.kind) {
      case "ready":
        loaded.set(task.key, { image: outcome.image, url: outcome.url });
        states.set(task.key, { kind: "ready", src: outcome.url.src });
        break;
      case "terminal":
        states.set(task.key, { kind: "failed" });
        break;
      case "transient":
        deferred.add(task.key);
        states.set(task.key, {
          kind: "deferred",
          retryScheduled: canScheduleReentry(task.key),
        });
        break;
      case "aborted":
        states.set(task.key, { kind: "idle" });
        break;
    }
    emit();
    if (outcome.kind === "transient" && canScheduleReentry(task.key)) {
      scheduleReentry(task.key, outcome.retryAfterMs);
    }
    pump();
  }

  function pump(): void {
    if (disposed || current) return;
    const key = nextCandidate();
    if (!key) return;

    const task: LoadTask = {
      key,
      controller: new AbortController(),
      image: null,
      provisionalUrl: null,
    };
    current = task;
    states.set(key, { kind: "loading", attempt: 1 });
    emit();
    void run(task).then((outcome) => finish(task, outcome));
  }

  function update(
    frames: readonly Pick<KmaRadarFrame, "t">[],
    activeIndex: number,
  ): void {
    if (disposed) return;
    const uniqueFrames: Array<Pick<KmaRadarFrame, "t">> = [];
    const seen = new Set<string>();
    for (const frame of frames) {
      if (!seen.has(frame.t)) {
        seen.add(frame.t);
        uniqueFrames.push(frame);
      }
    }
    const nextKeys = uniqueFrames.map((frame) => frame.t);
    const timelineChanged =
      nextKeys.length !== timelineKeys.length ||
      nextKeys.some((key, index) => key !== timelineKeys[index]);
    const nextKeySet = new Set(nextKeys);

    for (const key of timelineKeys) {
      if (nextKeySet.has(key)) continue;
      releaseLoaded(key);
      states.delete(key);
      deferred.delete(key);
      reentryCounts.delete(key);
      if (scheduledRetry?.key === key) cancelScheduledRetry(false);
    }

    if (timelineChanged) {
      cancelScheduledRetry(false);
      deferred.clear();
      reentryCounts.clear();
      for (const key of nextKeys) {
        const existing = states.get(key);
        if (!existing || existing.kind === "failed" || existing.kind === "deferred") {
          states.set(key, { kind: "idle" });
        }
      }
    }
    timelineKeys = nextKeys;
    priority = orderedRadarWarmup(uniqueFrames, activeIndex).map((frame) => frame.t);
    if (priority[0] && deferred.has(priority[0])) {
      if (scheduledRetry?.key === priority[0]) cancelScheduledRetry(false);
      deferred.delete(priority[0]);
      reentryCounts.delete(priority[0]);
      states.set(priority[0], { kind: "idle" });
    }

    const desired = nextCandidate();
    if (current && current.key !== desired) abortCurrent();
    emit();
    pump();
  }

  function reportVisibleError(key: string, src: string): void {
    if (disposed) return;
    const entry = loaded.get(key);
    if (!entry || entry.url.src !== src) return;
    releaseLoaded(key);
    if (!states.has(key)) return;
    states.set(key, { kind: "failed" });
    emit();
    pump();
  }

  function retry(): void {
    if (disposed) return;
    cancelScheduledRetry(false);
    deferred.clear();
    reentryCounts.clear();
    for (const [key, state] of states) {
      if (state.kind === "deferred") states.set(key, { kind: "idle" });
    }
    emit();
    pump();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    abortCurrent();
    cancelScheduledRetry(false);
    for (const key of [...loaded.keys()]) releaseLoaded(key);
    states.clear();
    timelineKeys = [];
    priority = [];
    deferred.clear();
    reentryCounts.clear();
    emit();
    listeners.clear();
  }

  return {
    update,
    getSnapshot: snapshot,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reportVisibleError,
    retry,
    dispose,
  };
}
