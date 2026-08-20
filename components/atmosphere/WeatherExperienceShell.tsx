"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLiveSeoulWeather } from "@/hooks/useLiveSeoulWeather";
import { useSeoulClock } from "@/hooks/useSeoulClock";
import {
  detectQuality,
  hasWebGL,
  prefersReducedMotion,
  type QualitySettings,
} from "@/components/three/quality";
import { computeSunPhase } from "@/lib/cinematic/seoulTime";
import { buildVisualConfig, readAtmosphere } from "@/lib/atmosphere/weatherVisualConfig";
import type { SkySnapshot, WeatherCondition } from "@/lib/types";
import SceneStage from "./scene/SceneStage";
import { SkyImageProvider } from "./scene/SkyImageContext";
import {
  WeatherClockProvider,
  WeatherFieldProvider,
  WeatherViewProvider,
  WeatherViewToggleProvider,
  type WeatherFieldValue,
  type WeatherView,
} from "./WeatherFieldContext";

const IS_DEV = process.env.NODE_ENV !== "production";

/** Don't let the D / Esc view-toggle fire while the user is typing in a field. */
function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return (el as HTMLElement).isContentEditable === true;
}

/**
 * Dev-only `?cond=&hour=` visual-review override (stripped to a no-op in prod, so
 * production behaviour is byte-identical). Lets a reviewer force the atmospheric
 * field to any weather + time-of-day — e.g. `/atmosphere?cond=rain&hour=19` — to
 * audit sunset / fog / snow / night without waiting for live conditions.
 */
interface ReviewOverride {
  cond?: WeatherCondition;
  hour?: number;
}

function parseReview(search: string): ReviewOverride {
  if (!IS_DEV) return {};
  const q = new URLSearchParams(search);
  const cond = q.get("cond");
  const hour = q.get("hour");
  const h = hour == null ? undefined : Number(hour);
  return {
    cond: (cond as WeatherCondition | null) ?? undefined,
    hour: Number.isFinite(h) ? h : undefined,
  };
}

/** Today's Seoul instant at a forced KST hour (dev review only). */
function seoulAtHour(hour: number): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const hh = String(Math.max(0, Math.min(23, Math.floor(hour)))).padStart(2, "0");
  return new Date(`${ymd}T${hh}:00:00+09:00`);
}

/** Overlay a forced condition on a snapshot (dev review only). */
function applyReviewCond(snapshot: SkySnapshot | null, cond?: WeatherCondition): SkySnapshot | null {
  if (!cond || !snapshot) return snapshot;
  return { ...snapshot, current: { ...snapshot.current, condition: cond } };
}

/**
 * The single page shell for the retired weather experience. It owns one live
 * data source and ONE persistent {@link SceneStage} (the still landmark plate,
 * live FX, and the procedural atmospheric-field fallback). Both are created once
 * in that layout and never remount, because the
 * experience is a single non-navigating scroll. The readable foreground (the
 * scroll content) is passed in as `children` and reads the shared state from
 * {@link WeatherFieldProvider}.
 */

function Loader() {
  return (
    <div className="sky-fixed-viewport z-50 flex items-center justify-center bg-[#04060d]">
      <div role="status" className="flex flex-col items-center text-center text-[#f6f0e4]">
        <span className="font-sans text-2xl font-semibold tracking-[-0.035em]">서울의 하늘</span>
        <span className="mt-4 h-px w-24 overflow-hidden bg-white/15">
          <span className="block h-full w-1/2 animate-pulse bg-white/70" />
        </span>
        <span className="mt-3 font-sans text-[11px] tracking-[0.16em] text-white/55">
          날씨 정보를 불러오는 중
        </span>
      </div>
    </div>
  );
}

function InitialWeatherFailure({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[clamp(1.5rem,5vh,3rem)] z-40 flex justify-center px-5">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto max-w-md rounded-[1.35rem] border border-white/18 bg-[#050814]/70 px-5 py-4 text-white shadow-[0_22px_60px_-28px_rgba(0,0,0,0.8)] backdrop-blur-xl"
      >
        <p className="font-sans text-base font-light">현재 서울 날씨를 불러오지 못했습니다.</p>
        <p className="mt-1 text-sm leading-relaxed text-white/70">잠시 후 다시 시도해 주세요.</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 min-h-11 rounded-full border border-white/20 px-3.5 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-white transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/50"
        >
          다시 시도
        </button>
      </div>
    </div>
  );
}

export default function WeatherExperienceShell({ children }: { children: ReactNode }) {
  const { snapshot, status, lastUpdatedAt, refresh } = useLiveSeoulWeather();
  const clock = useSeoulClock();

  const [quality, setQuality] = useState<QualitySettings | null>(null);
  const [reduced, setReduced] = useState(false);
  const [webgl, setWebgl] = useState(true);
  const [pointerEnabled, setPointerEnabled] = useState(false);
  const [canvasFailed, setCanvasFailed] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [review, setReview] = useState<ReviewOverride>({});
  // The two discrete, keyboard-toggled views. The whole experience is desktop
  // keyboard-driven: D toggles hero ↔ data, Esc always returns to the hero.
  const [view, setView] = useState<WeatherView>("hero");

  // The single hero ↔ data toggle. Fired by both the desktop D key and the
  // on-screen "데이터 · explore" tap target (the only touch affordance), so the
  // two paths share one source of truth with no duplicated state logic.
  const toggleView = useCallback(() => setView((v) => (v === "hero" ? "data" : "hero")), []);

  // Client-only capability detection (no SSR/hydration divergence).
  useEffect(() => {
    const reducedNow = prefersReducedMotion();
    setQuality(detectQuality());
    setReduced(reducedNow);
    setWebgl(hasWebGL());
    setReview(parseReview(window.location.search));
    setPointerEnabled(
      !reducedNow &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(pointer: fine)").matches,
    );
  }, []);

  // Keyboard navigation between the two views (desktop only — no touch
  // affordance). D toggles hero ↔ data; Esc always returns to the hero. Inert
  // while typing or holding a command modifier, and ignores auto-repeat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(document.activeElement)) return;
      // Match the physical key via e.code, not e.key: under a Korean IME the D key
      // yields e.key "ㅇ", so e.key-based matching silently breaks. e.code is the
      // QWERTY-position key, independent of layout/IME, and is unaffected by Shift.
      switch (e.code) {
        case "KeyD":
          toggleView();
          break;
        case "Escape":
          setView("hero");
          break;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleView]);

  // Pause the GL loop while the tab is hidden (battery / GPU).
  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Keep reduced-motion live: a DevTools/OS toggle re-gates the FX, parallax
  // and sheen without a reload, since every consumer reacts to the prop
  // (SceneStage drops the FX layer, the sheen listener detaches). Pointer
  // parallax follows the same gate.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => {
      setReduced(mq.matches);
      setPointerEnabled(!mq.matches && window.matchMedia("(pointer: fine)").matches);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // A dev review override (?cond=&hour=) recolours the field for visual audits;
  // in production `review` is always empty, so these collapse to the live values.
  const readout = useMemo(
    () => readAtmosphere(applyReviewCond(snapshot, review.cond)),
    [snapshot, review.cond],
  );

  // Rebuild the visual target + day/night on a coarse cadence (every 30s) + on
  // every weather refresh. The background lerps toward the target, so steps are
  // invisibly smooth; `isDay` is derived from the SAME sun phase here (not the
  // per-second clock) so it flips at sunrise/sunset without re-rendering the
  // heavy scene every tick.
  const tick = clock ? Math.floor(clock.getTime() / 30000) : 0;
  const { target, isDay, dayFactor, goldenFactor, rising, elevation } = useMemo(() => {
    const eff = applyReviewCond(snapshot, review.cond);
    const at =
      review.hour != null ? seoulAtHour(review.hour) : tick > 0 ? new Date(tick * 30000) : new Date();
    const sun = computeSunPhase({
      now: at,
      sunrise: snapshot?.sun.sunrise,
      sunset: snapshot?.sun.sunset,
      isDayHint: review.hour != null ? undefined : snapshot?.current.isDay,
    });
    return {
      target: buildVisualConfig(sun, eff),
      isDay: sun.isDay,
      dayFactor: sun.dayFactor,
      goldenFactor: sun.goldenFactor,
      rising: sun.rising,
      elevation: sun.elevation,
    };
  }, [tick, snapshot, review.cond, review.hour]);

  // Stable reference so the memoized SceneStage isn't re-rendered each tick.
  const onCanvasError = useCallback(() => setCanvasFailed(true), []);

  // The shared coarse state. Memoized so its identity is stable across the
  // per-second clock ticks above — consumers (incl. the memoized SceneStage)
  // re-render only when the weather/visual target actually changes.
  const fieldValue = useMemo<WeatherFieldValue>(
    () => ({
      snapshot,
      status,
      lastUpdatedAt,
      readout,
      target,
      isDay,
      dayFactor,
      goldenFactor,
      rising,
      elevation,
    }),
    [snapshot, status, lastUpdatedAt, readout, target, isDay, dayFactor, goldenFactor, rising, elevation],
  );

  // Pre-detection (and SSR): a calm loader — no canvas, no hydration mismatch.
  if (!quality) return <Loader />;

  // The scene is invisible while the data dashboard is up (it sits behind the
  // opaque gradient), so suspend the gallery + FX + field exactly as when the tab
  // is hidden — no video decoding behind the dashboard.
  const sceneHidden = hidden || view === "data";
  const initialWeatherFailed = status === "error" && snapshot === null;

  return (
    <WeatherFieldProvider value={fieldValue}>
      {/* The still color-field plate (selected + preloaded + graded once) is shared
          by the scene background AND the defocused data-view backdrop, so the
          D-toggle reads as one cohesive image at two depths. */}
      <SkyImageProvider>
        {/* Layer 0 — the persistent scene (edge-to-edge still color-field plate +
            live FX, with the procedural field as the never-blank fallback). It
            reads only the coarse field state, so the per-second clock never
            re-renders it. */}
        <SceneStage
          quality={quality}
          reducedMotion={reduced}
          hidden={sceneHidden}
          pointerEnabled={pointerEnabled}
          webgl={webgl}
          canvasFailed={canvasFailed}
          onCanvasError={onCanvasError}
        />

        {initialWeatherFailed && <InitialWeatherFailure onRetry={refresh} />}

        {/* The two view layers render their own scrim + readable foreground above
            the shared scene, cross-fading on the D-toggle. The live clock is scoped
            here — only the sections that display ticking time subscribe to it. */}
        <WeatherViewProvider value={view}>
          <WeatherViewToggleProvider value={toggleView}>
            <WeatherClockProvider value={clock}>{children}</WeatherClockProvider>
          </WeatherViewToggleProvider>
        </WeatherViewProvider>
      </SkyImageProvider>
    </WeatherFieldProvider>
  );
}
