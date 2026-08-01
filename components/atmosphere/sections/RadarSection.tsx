"use client";

import { useInView, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useDeferredJson } from "@/hooks/useDeferredJson";
import {
  createRadarFrameLoader,
  type RadarClientFrameState,
  type RadarFrameLoader,
} from "@/lib/radar/clientLoader";
import { RADAR_CONFIG, RADAR_LEGEND } from "@/lib/radar/config";
import {
  advanceReadyRadarFrame,
  buildRadarMosaic,
  formatRadarFrameTime,
  radarApproachSummary,
  RADAR_BASEMAP_ATTRIBUTION,
  radarFrameTag,
  resolveRadarTimeline,
} from "@/lib/radar/presentation";
import type { KmaRadarFrame, KmaRadarFrames, RadarBounds } from "@/lib/types";
import { MetricLabel } from "../EtchedType";
import { ScrollReveal } from "../descentMotion";
import { useWeatherField } from "../WeatherFieldContext";
import { SectionHeading, SkySection } from "./SectionParts";

/**
 * Section 3 — Radar (강수 레이더). A Seoul-centred precipitation scope built on the KMA
 * high-resolution reflectivity grid (HSR @ ~500 m, apihub.kma.go.kr): the server crops
 * it to the Seoul metro, reprojects it to Web Mercator, and renders a transparent echo
 * PNG (the key + 13 MB grid never reach the client — see lib/radar/*). Here we lay that
 * echo over a keyless CARTO dark basemap, georeferenced by the crop's lat/lon bounds so
 * rain falls on the right geography. A timeline scrubber spans the last ~1h of
 * observation with play/pause; the grid is observed-only (no nowcast).
 *
 * Data: GET /api/radar/frames (the frame list + geo bounds), fetched only as the section
 * approaches (useInView). Playback/scrub state is LOCAL (a timer + activeIndex) so the
 * scene isn't re-rendered by the animation. The approach one-liner reads the coarse
 * snapshot.radar from the field context — an independent (RainViewer) approach signal.
 */

// ---- the radar scope (CARTO basemap + georeferenced KMA echo) ----------------

function RadarScope({
  frame,
  frameSrc,
  nowMs,
  bounds,
  onFrameError,
}: {
  frame: KmaRadarFrame;
  frameSrc: string;
  nowMs: number;
  bounds: RadarBounds;
  onFrameError: (key: string, src: string) => void;
}) {
  // The scope is a self-contained DARK panel in BOTH adaptive modes, so re-establish
  // real white for its descendants (the surrounding glass re-scopes --color-white).
  const scopeInk = { ["--color-white" as string]: "rgb(255,255,255)" } as CSSProperties;
  const m = useMemo(() => buildRadarMosaic(bounds), [bounds]);

  return (
    <div
      style={scopeInk}
      className="relative aspect-square w-full overflow-hidden rounded-[0.4rem] bg-[#070a14] ring-1 ring-white/10"
    >
      {/* Cover-fit map viewport: the bbox is laid out at its Mercator aspect and scaled
          uniformly to fill the square scope (conformal — basemap + echo stay registered). */}
      <div className="absolute inset-0 flex items-center justify-center overflow-hidden">
        <div
          className="relative"
          style={{
            aspectRatio: `${m.wpW} / ${m.wpH}`,
            height: m.wider ? "100%" : "auto",
            width: m.wider ? "auto" : "100%",
          }}
        >
          {/* CARTO dark_nolabels tiles (keyless dark base; Korean labels are our own overlay
              below, since CARTO's labelled rasters romanise Korean names). Raw <img> by design:
              next/image can't help with many small cross-origin raster tiles that must be
              %-positioned to the Mercator grid. */}
          {m.tiles.map((t) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={`${t.x}-${t.y}`}
              src={t.url}
              alt=""
              aria-hidden
              draggable={false}
              className="pointer-events-none absolute select-none"
              style={{ left: `${t.left}%`, top: `${t.top}%`, width: `${t.w}%`, height: `${t.h}%` }}
            />
          ))}

          {/* Controller-decoded KMA echo, georeferenced to the full bbox (= this layer).
              Reprojected + bilinear-smoothed server-side; a touch of blur softens any
              residual steps. The visible element receives only an owned blob URL. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={`${frame.t}:${frameSrc}`}
            src={frameSrc}
            alt=""
            aria-hidden
            draggable={false}
            onError={() => onFrameError(frame.t, frameSrc)}
            className="pointer-events-none absolute inset-0 h-full w-full select-none"
            style={{ filter: "blur(0.4px) saturate(1.05)" }}
          />

          {/* Korean place labels (anchor dot + name), positioned by lat/lon. 서울 emphasised;
              this is also the visible registration check — names land on the right geography. */}
          {m.labels.map((l) => {
            const isSeoul = l.ko === "서울";
            return (
              <div
                key={l.ko}
                className="pointer-events-none absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5"
                style={{ left: `${l.left}%`, top: `${l.top}%` }}
                aria-hidden
              >
                <span
                  className="block rounded-full bg-white/60"
                  style={{
                    width: isSeoul ? 6 : 3,
                    height: isSeoul ? 6 : 3,
                    boxShadow: isSeoul ? "0 0 8px 2px rgba(255,255,255,0.5)" : "none",
                  }}
                />
                <span
                  className="whitespace-nowrap font-sans text-white"
                  style={{
                    fontSize: isSeoul ? "12px" : "10px",
                    fontWeight: isSeoul ? 500 : 400,
                    opacity: isSeoul ? 0.95 : 0.62,
                    textShadow: "0 1px 3px rgba(0,0,0,0.9)",
                  }}
                >
                  {l.ko}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Cinematic vignette to deepen the edges. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(120% 120% at 50% 45%, transparent 60%, rgba(4,6,12,0.5) 100%)" }}
        aria-hidden
      />

      {/* Frame time overlay (on the imagery, radar-style). */}
      <span className="pointer-events-none absolute bottom-2.5 left-3 font-mono text-[11px] tabular-nums tracking-[0.1em] text-white/80">
        {formatRadarFrameTime(frame.time)} · {radarFrameTag(frame, nowMs)}
      </span>
      {/* Required attribution, on the radar imagery itself. */}
      <span className="pointer-events-none absolute bottom-2.5 right-3 font-mono text-[10px] tracking-[0.12em] text-white/55">
        © 기상청 · {RADAR_BASEMAP_ATTRIBUTION}
      </span>
    </div>
  );
}

function RadarMapPlaceholder({ active }: { active: boolean }) {
  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-[0.4rem] bg-[#070a14] ring-1 ring-white/10" aria-hidden>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_52%_48%,rgba(255,255,255,0.08),transparent_28%),linear-gradient(135deg,rgba(148,163,184,0.12),rgba(15,23,42,0.08)_42%,rgba(56,189,248,0.10))]" />
      <div className="absolute inset-x-[12%] top-[31%] h-px rotate-[-8deg] bg-white/12" />
      <div className="absolute inset-x-[18%] top-[58%] h-px rotate-[10deg] bg-white/10" />
      <div className="absolute left-[20%] top-[22%] h-16 w-px rotate-[18deg] bg-white/10" />
      <div className="absolute right-[24%] top-[18%] h-28 w-px rotate-[-16deg] bg-white/10" />
      <div className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/60 shadow-[0_0_18px_rgba(255,255,255,0.55)]" />
      <div className="absolute inset-0 bg-[radial-gradient(120%_120%_at_50%_45%,transparent_58%,rgba(4,6,12,0.56)_100%)]" />
      {active && (
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent opacity-50 motion-safe:animate-pulse" />
      )}
    </div>
  );
}

function RadarStatePanel({
  title,
  description,
  detail,
  loading = false,
}: {
  title: string;
  description: string;
  detail: string;
  loading?: boolean;
}) {
  return (
    <div
      className="flex flex-col gap-5 lg:flex-row lg:items-center lg:gap-6"
      role={loading ? "status" : undefined}
      aria-live={loading ? "polite" : undefined}
    >
      <div className="mx-auto w-full max-w-[32rem] lg:mx-0 lg:flex-[0_0_auto] lg:max-w-[clamp(21rem,52vh,32rem)]">
        <RadarMapPlaceholder active={loading} />
      </div>
      <div className="flex flex-1 flex-col justify-center gap-3">
        <MetricLabel tone="bright">서울의 비구름</MetricLabel>
        <p className="sky-display text-[clamp(1.5rem,2.8vw,2.2rem)] leading-tight text-white">
          {title}
        </p>
        <p className="max-w-md text-sm leading-relaxed text-white/75">{description}</p>
        <p className="font-mono text-[11px] leading-relaxed tracking-[0.12em] text-white/65">{detail}</p>
      </div>
    </div>
  );
}

// ---- timeline scrubber (local state) ----------------------------------------

function Scrubber({
  frames,
  index,
  nowIndex,
  onSeek,
}: {
  frames: KmaRadarFrame[];
  index: number;
  nowIndex: number;
  onSeek: (i: number, direction?: -1 | 1) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const n = frames.length;
  const pct = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 0);
  const nowPct = pct(nowIndex);
  // Only mark a forward "nowcast" zone when real nowcast frames exist (the KMA grid is
  // observed-only) — never imply a forecast that isn't there.
  const hasNowcast = frames.some((f) => f.nowcast);

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || n <= 1) return;
      const rect = el.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      onSeek(Math.round(frac * (n - 1)));
    },
    [n, onSeek],
  );

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label="레이더 타임라인 — 관측 과거에서 현재까지"
      aria-valuemin={0}
      aria-valuemax={n - 1}
      aria-valuenow={index}
      aria-valuetext={radarFrameTag(frames[index], new Date(frames[nowIndex].time).getTime())}
      onPointerDown={(e) => {
        draggingRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        seekFromClientX(e.clientX);
      }}
      onPointerMove={(e) => {
        if (draggingRef.current) seekFromClientX(e.clientX);
      }}
      onPointerUp={(e) => {
        draggingRef.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onSeek(Math.max(0, index - 1), -1);
        else if (e.key === "ArrowRight") onSeek(Math.min(n - 1, index + 1), 1);
        else if (e.key === "Home") onSeek(0, 1);
        else if (e.key === "End") onSeek(n - 1, -1);
        else return;
        e.preventDefault();
      }}
      className="relative h-9 cursor-pointer touch-none select-none rounded-md outline-none focus-visible:ring-1 focus-visible:ring-white/40"
    >
      {/* base track */}
      <div className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/15" />
      {/* nowcast (forward) portion — striped + lighter, honestly "예보" */}
      {hasNowcast && nowPct < 100 && (
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full"
          style={{
            left: `${nowPct}%`,
            right: 0,
            background:
              "repeating-linear-gradient(90deg, currentColor 0 2px, transparent 2px 6px)",
            opacity: 0.35,
          }}
        />
      )}
      {/* observed progress up to the handle */}
      <div
        className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-current"
        style={{ left: 0, width: `${pct(index)}%`, opacity: 0.5 }}
      />
      {/* per-frame ticks */}
      {frames.map((f, i) => (
        <span
          key={f.time}
          className="absolute top-1/2 h-2 w-px -translate-x-1/2 -translate-y-1/2 bg-current"
          style={{ left: `${pct(i)}%`, opacity: 0.22 }}
        />
      ))}
      {/* "now" divider + label */}
      <span className="absolute top-1/2 h-3.5 w-px -translate-x-1/2 -translate-y-1/2 bg-current" style={{ left: `${nowPct}%`, opacity: 0.7 }} />
      <span className="absolute -top-0.5 -translate-x-1/2 font-mono text-[9px] uppercase tracking-[0.2em] text-white" style={{ left: `${nowPct}%` }}>
        지금
      </span>
      {/* handle */}
      <span
        className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current"
        style={{ left: `${pct(index)}%`, boxShadow: "0 0 0 3px var(--sky-panel-bg, rgba(12,16,30,0.26)), 0 1px 4px rgba(0,0,0,0.4)" }}
      />
    </div>
  );
}

// ---- section ----------------------------------------------------------------

const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // re-pull the frame list periodically

function nearestReadyFrameIndex(
  frames: readonly KmaRadarFrame[],
  activeIndex: number,
  readyKeys: ReadonlySet<string>,
  failedKeys: ReadonlySet<string>,
  preferredDirection: -1 | 1 = -1,
): number | null {
  if (frames.length === 0) return null;
  const activeKey = frames[activeIndex]?.t;
  if (!activeKey) return null;
  if (readyKeys.has(activeKey)) return activeIndex;
  if (!failedKeys.has(activeKey)) return null;

  for (let distance = 1; distance < frames.length; distance++) {
    const preferred = activeIndex + distance * preferredDirection;
    if (preferred >= 0 && preferred < frames.length && readyKeys.has(frames[preferred].t)) {
      return preferred;
    }

    const alternate = activeIndex - distance * preferredDirection;
    if (alternate >= 0 && alternate < frames.length && readyKeys.has(frames[alternate].t)) {
      return alternate;
    }
  }

  return null;
}

export default function RadarSection() {
  const { snapshot } = useWeatherField();
  const reduce = !!useReducedMotion();
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [autoPlayRequested, setAutoPlayRequested] = useState(false);
  const [frameStates, setFrameStates] = useState<
    ReadonlyMap<string, RadarClientFrameState>
  >(() => new Map());
  const frameLoaderRef = useRef<RadarFrameLoader | null>(null);

  const sectionRef = useRef<HTMLDivElement>(null);
  const near = useInView(sectionRef, { once: true, margin: "0px 0px 400px 0px" });

  const { data: summary, failed } = useDeferredJson<KmaRadarFrames>({
    enabled: near,
    url: "/api/radar/frames",
    refreshIntervalMs: REFRESH_INTERVAL_MS,
  });

  const frames = useMemo(() => summary?.frames ?? [], [summary]);
  const bounds = summary?.bounds ?? null;
  const timeline = useMemo(() => resolveRadarTimeline(frames, index), [frames, index]);
  const available =
    !!summary?.available && frames.length > 0 && !!bounds && timeline.latestObservedMs !== null;
  const nowIndex = timeline.latestIndex;
  const nowMs = timeline.latestObservedMs ?? 0;
  const activeIndex = available ? timeline.activeIndex : 0;
  const readyFrameKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const [key, state] of frameStates) {
      if (state.kind === "ready") keys.add(key);
    }
    return keys;
  }, [frameStates]);
  const failedFrameKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const [key, state] of frameStates) {
      if (state.kind === "failed") keys.add(key);
    }
    return keys;
  }, [frameStates]);
  const warmupBlocked = useMemo(
    () =>
      [...frameStates.values()].some(
        (state) => state.kind === "deferred" && !state.retryScheduled,
      ),
    [frameStates],
  );
  const displayIndex = available
    ? nearestReadyFrameIndex(frames, activeIndex, readyFrameKeys, failedFrameKeys)
    : null;
  const displayFrame = displayIndex === null ? null : frames[displayIndex];
  const displayState = displayFrame ? frameStates.get(displayFrame.t) : null;
  const displayFrameSrc = displayState?.kind === "ready" ? displayState.src : null;
  const activeFrameFailed =
    available && failedFrameKeys.has(frames[activeIndex].t);
  const activeFrameReady =
    available && readyFrameKeys.has(frames[activeIndex].t);
  const playbackFrameReady =
    activeFrameReady || (activeFrameFailed && displayIndex !== null);

  useEffect(() => {
    const loader = createRadarFrameLoader();
    frameLoaderRef.current = loader;
    const unsubscribe = loader.subscribe(setFrameStates);
    return () => {
      unsubscribe();
      loader.dispose();
      if (frameLoaderRef.current === loader) frameLoaderRef.current = null;
    };
  }, []);

  useEffect(() => {
    frameLoaderRef.current?.update(available ? frames : [], activeIndex);
  }, [activeIndex, available, frames]);

  useEffect(() => {
    if (!summary) return;
    // Park at the latest observation; decoded readiness gates actual playback.
    setIndex(Math.max(0, summary.frames.length - 1));
    setPlaying(false);
    setAutoPlayRequested(!reduce && summary.available && summary.frames.length > 1);
  }, [summary, reduce]);

  useEffect(() => {
    if (!autoPlayRequested || reduce || !playbackFrameReady || frames.length <= 1) return;
    setPlaying(true);
    setAutoPlayRequested(false);
  }, [autoPlayRequested, frames.length, playbackFrameReady, reduce]);

  // Playback waits at an unloaded next frame and skips only known terminal failures.
  useEffect(() => {
    if (!playing || !playbackFrameReady || frames.length <= 1) return;
    const id = setInterval(() => {
      setIndex((currentIndex) =>
        advanceReadyRadarFrame(
          currentIndex,
          frames,
          readyFrameKeys,
          failedFrameKeys,
        ),
      );
    }, RADAR_CONFIG.playIntervalMs);
    return () => clearInterval(id);
  }, [failedFrameKeys, frames, playbackFrameReady, playing, readyFrameKeys]);

  useEffect(() => {
    if (playing && warmupBlocked) setPlaying(false);
  }, [playing, warmupBlocked]);

  const onSeek = useCallback(
    (i: number) => {
      setPlaying(false);
      setAutoPlayRequested(false);
      setIndex(i);
    },
    [],
  );

  const onTogglePlayback = useCallback(() => {
    if (playing) {
      setPlaying(false);
      setAutoPlayRequested(false);
      return;
    }
    frameLoaderRef.current?.retry();
    if (playbackFrameReady) {
      setPlaying(true);
      return;
    }
    setAutoPlayRequested(true);
  }, [playbackFrameReady, playing]);

  const onVisibleFrameError = useCallback((key: string, src: string) => {
    frameLoaderRef.current?.reportVisibleError(key, src);
  }, []);

  const waitingForFrame = available && displayIndex === null && !activeFrameFailed;

  return (
    <SkySection id="rain" compact>
      <SectionHeading
        index="04"
        title="레이더"
        compact
      />

      <div ref={sectionRef} className="flex flex-1 flex-col justify-center">
        <ScrollReveal amount={0.12}>
          <div className="sky-film-surface sky-outline-surface mx-auto w-full max-w-[80rem] px-5 py-6 sm:px-8 sm:py-8 lg:px-10 lg:py-10">
            {!available || !bounds || !displayFrame || !displayFrameSrc || displayIndex === null ? (
              <RadarEmpty
                near={near}
                failed={failed || (available && activeFrameFailed && displayIndex === null)}
                loaded={summary !== null && !waitingForFrame}
              />
            ) : (
              <>
                <div className="grid gap-8 lg:grid-cols-[minmax(22rem,0.9fr)_minmax(0,1fr)] lg:items-center lg:gap-12">
                  {/* Scope */}
                  <div className="mx-auto w-full max-w-[34rem] lg:mx-0">
                    <RadarScope
                      frame={displayFrame}
                      frameSrc={displayFrameSrc}
                      nowMs={nowMs}
                      bounds={bounds}
                      onFrameError={onVisibleFrameError}
                    />
                  </div>

                  {/* Readout + legend */}
                  <div className="flex flex-1 flex-col justify-center gap-5">
                    <div className="flex flex-col gap-2">
                      <MetricLabel tone="bright">지금, 서울 상공</MetricLabel>
                      <p className="sky-display max-w-[18ch] break-keep text-[clamp(1.75rem,3.6vw,3.2rem)] leading-[1.25] text-white">
                        {radarApproachSummary(snapshot?.radar)}
                      </p>
                      <p className="font-mono text-[12px] tracking-[0.12em] text-white">
                        {formatRadarFrameTime(displayFrame.time)} · {radarFrameTag(displayFrame, nowMs)}
                      </p>
                      {activeFrameFailed && (
                        <p className="max-w-md text-sm leading-relaxed text-white/75">
                          기상청 레이더 이미지를 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.
                        </p>
                      )}
                    </div>

                    {/* Intensity legend (light → heavy). */}
                    <div className="flex flex-col gap-2">
                      <MetricLabel tone="bright">강수 강도</MetricLabel>
                      <div
                        className="h-2.5 w-full max-w-[18rem] rounded-full ring-1 ring-inset ring-white/15"
                        style={{ background: `linear-gradient(90deg, ${RADAR_LEGEND.map((s) => s.color).join(", ")})` }}
                        aria-hidden
                      />
                      <div className="flex w-full max-w-[18rem] justify-between font-mono text-[10px] tracking-[0.12em] text-white">
                        {RADAR_LEGEND.filter((s) => s.label).map((s) => (
                          <span key={s.label}>{s.label}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Timeline: play/pause + scrubber spanning the observed past → now. */}
                <div className="mt-5 flex items-center gap-4">
                  <button
                    type="button"
                    onClick={onTogglePlayback}
                    aria-label={playing ? "일시정지" : "재생"}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full ring-1 ring-inset ring-white/25 text-white transition hover:bg-white/10"
                  >
                    {playing ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                        <rect x="6" y="5" width="4" height="14" rx="1" />
                        <rect x="14" y="5" width="4" height="14" rx="1" />
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                        <path d="M7 5l12 7-12 7z" />
                      </svg>
                    )}
                  </button>
                  <div className="flex-1">
                    <Scrubber frames={frames} index={displayIndex} nowIndex={nowIndex} onSeek={onSeek} />
                  </div>
                </div>

                <p className="mt-3 font-mono text-[11px] leading-relaxed tracking-[0.1em] text-white">
                  최근 약 1시간 관측 · 고해상도 강수 레이더 · 서울 중심 · 출처 © 기상청(KMA) · {RADAR_BASEMAP_ATTRIBUTION}
                </p>
              </>
            )}
          </div>
        </ScrollReveal>
      </div>
    </SkySection>
  );
}

/** Honest non-data states: not-yet-loading, loading, failed, or no frames — never invents radar. */
function RadarEmpty({ near, failed, loaded }: { near: boolean; failed: boolean; loaded: boolean }) {
  if (!near) {
    return (
      <RadarStatePanel
        loading
        title="레이더 지도 준비 중"
        description="기상청 레이더 이미지를 불러오고 있어요."
        detail="서울 중심 · 고해상도 강수 레이더 · © 기상청(KMA)"
      />
    );
  }
  // Failed fetch, or the fetch resolved with no usable frames → honest empty state.
  if (failed || loaded) {
    return (
      <RadarStatePanel
        title="표시할 레이더 데이터가 없어요."
        description={
          failed
            ? "기상청 레이더 이미지를 불러오지 못했습니다. 잠시 후 다시 확인해 주세요."
            : "현재 사용 가능한 레이더 이미지가 없습니다. 잠시 후 다시 확인해 주세요."
        }
        detail="출처 © 기상청(KMA)"
      />
    );
  }
  // In view, fetch still in flight.
  return (
    <RadarStatePanel
      loading
      title="레이더 지도 준비 중"
      description="기상청 레이더 이미지를 불러오고 있어요."
      detail="최근 약 1시간 관측 프레임을 준비하는 중입니다."
    />
  );
}
