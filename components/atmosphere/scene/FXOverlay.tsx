"use client";

import { useEffect, useRef } from "react";
import type { QualitySettings } from "@/components/three/quality";

/**
 * The live weather FX overlay — layer (c) of the retired scene. A single 2D canvas
 * over the still color-field plate, driven by the LIVE weather: rain streaks,
 * snowfall, a random lightning flash in thunderstorms, a drifting fog veil, and
 * sun god-rays. It is GPU-cheap (one canvas, one rAF loop, capped particle
 * counts) and gated by the existing quality tiers.
 *
 * Live values arrive as a plain {@link FxState} and are read through a ref each
 * frame, so React never re-renders for motion (same pattern as the atmospheric
 * field). It is paused when the tab is hidden.
 *
 * `prefers-reduced-motion` is honoured HERE rather than by the parent omitting
 * the layer, and it is watched live so a runtime toggle takes effect without a
 * remount: when reduced, the rAF loop never runs and we paint a single STATIC
 * ambient frame — the non-moving atmosphere only (fog veil + god-ray gradient),
 * with no rain / snow / lightning — so the scene never hard-cuts all atmosphere.
 */

export interface FxState {
  /** 0..1 rain intensity (drives streak count). */
  rain: number;
  /** 0..1 snow intensity. */
  snow: number;
  /** 0..1 fog/haze veil density. */
  haze: number;
  /** Sun position in 0..1, y UP (shader convention). */
  sunPos: readonly [number, number];
  /** Sun colour, rgb 0..1. */
  sunColor: readonly [number, number, number];
  /** 0..1 effective sun intensity (already folds cloud occlusion). */
  sunIntensity: number;
  /** Unit wind drift direction, y UP. */
  windDir: readonly [number, number];
  /** Thunderstorm now — enables the lightning flash. */
  lightning: boolean;
}

interface FxCounts {
  rain: number;
  snow: number;
  rays: number;
}

function countsFor(tier: QualitySettings["tier"]): FxCounts {
  if (tier === "high") return { rain: 900, snow: 600, rays: 7 };
  if (tier === "balanced") return { rain: 520, snow: 360, rays: 5 };
  return { rain: 240, snow: 180, rays: 4 };
}

interface RainP {
  x: number;
  y: number;
  len: number;
  spd: number;
}
interface SnowP {
  x: number;
  y: number;
  r: number;
  spd: number;
  phase: number;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const ch = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255);

export interface FXOverlayProps {
  fx: FxState;
  quality: QualitySettings;
  /** Tab hidden — stop the loop. */
  paused: boolean;
}

export default function FXOverlay({ fx, quality, paused }: FXOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fxRef = useRef<FxState>(fx);
  fxRef.current = fx;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const controlRef = useRef<{ apply: () => void; redrawStatic: () => void } | null>(null);

  // Build the canvas + particle pools + render loop. Rebuilt only when the
  // quality tier changes (pool sizes bake in here); live weather flows via ref.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const counts = countsFor(quality.tier);
    // Cap the backing-store resolution: FX reads fine at ≤1.5x and this keeps
    // fill-rate low on dense rain.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let w = 0;
    let h = 0;
    const resize = () => {
      const cw = canvas.clientWidth;
      const chh = canvas.clientHeight;
      w = Math.max(1, Math.round(cw * dpr));
      h = Math.max(1, Math.round(chh * dpr));
      canvas.width = w;
      canvas.height = h;
    };
    resize();

    const rain: RainP[] = Array.from({ length: counts.rain }, () => ({
      x: rnd(0, w),
      y: rnd(0, h),
      len: rnd(12, 26) * dpr,
      spd: rnd(900, 1500) * dpr,
    }));
    const snow: SnowP[] = Array.from({ length: counts.snow }, () => ({
      x: rnd(0, w),
      y: rnd(0, h),
      r: rnd(0.8, 2.4) * dpr,
      spd: rnd(40, 110) * dpr,
      phase: rnd(0, Math.PI * 2),
    }));
    // Lightning flash state (random interval while a storm is active).
    let flash = 0; // current brightness 0..1
    let nextFlashAt = performance.now() + rnd(2500, 7000);

    let raf = 0;
    let last = performance.now();
    let timeS = 0;

    const drawFog = (haze: number) => {
      if (haze < 0.04) return;
      const a = Math.min(0.22, haze * 0.2);
      // a soft overall veil, denser low in the frame
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, `rgba(196,202,212,${a * 0.4})`);
      g.addColorStop(1, `rgba(178,186,198,${a})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      // one slow drifting bank
      const driftX = ((timeS * 8 * dpr) % (w + 400 * dpr)) - 200 * dpr;
      const band = ctx.createRadialGradient(driftX, h * 0.7, 0, driftX, h * 0.7, w * 0.6);
      band.addColorStop(0, `rgba(200,206,216,${a * 0.7})`);
      band.addColorStop(1, "rgba(200,206,216,0)");
      ctx.fillStyle = band;
      ctx.fillRect(0, 0, w, h);
    };

    const drawGodRays = (s: FxState) => {
      if (s.sunIntensity < 0.16) return;
      const sx = s.sunPos[0] * w;
      const sy = (1 - s.sunPos[1]) * h;
      const col = `${ch(s.sunColor[0])},${ch(s.sunColor[1])},${ch(s.sunColor[2])}`;
      const baseA = s.sunIntensity * (1 - s.haze * 0.5) * 0.06;
      if (baseA < 0.008) return;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const reach = Math.hypot(w, h) * 1.1;
      for (let i = 0; i < counts.rays; i++) {
        const ang =
          Math.PI / 2 + // downward-ish
          (i - (counts.rays - 1) / 2) * 0.14 +
          Math.sin(timeS * 0.18 + i) * 0.03;
        const spread = (10 + i * 3) * dpr;
        const ex = sx + Math.cos(ang) * reach;
        const ey = sy + Math.sin(ang) * reach;
        const nx = Math.cos(ang + Math.PI / 2) * spread;
        const ny = Math.sin(ang + Math.PI / 2) * spread;
        const grad = ctx.createLinearGradient(sx, sy, ex, ey);
        grad.addColorStop(0, `rgba(${col},${baseA})`);
        grad.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(sx - nx, sy - ny);
        ctx.lineTo(sx + nx, sy + ny);
        ctx.lineTo(ex + nx * 1.6, ey + ny * 1.6);
        ctx.lineTo(ex - nx * 1.6, ey - ny * 1.6);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    };

    const drawSnow = (intensity: number, dt: number, s: FxState) => {
      const active = Math.floor(snow.length * intensity);
      if (active <= 0) return;
      ctx.fillStyle = "rgba(244,247,252,0.9)";
      const windX = s.windDir[0] * 30 * dpr;
      for (let i = 0; i < active; i++) {
        const p = snow[i];
        p.y += p.spd * dt;
        p.phase += dt * 1.2;
        p.x += (Math.sin(p.phase) * 14 * dpr + windX) * dt;
        if (p.y > h) {
          p.y = -4 * dpr;
          p.x = rnd(0, w);
        }
        if (p.x < -8) p.x = w;
        else if (p.x > w + 8) p.x = 0;
        ctx.globalAlpha = 0.55 + 0.45 * (p.r / (2.4 * dpr));
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const drawRain = (intensity: number, dt: number, s: FxState) => {
      const active = Math.floor(rain.length * intensity);
      if (active <= 0) return;
      const tiltX = s.windDir[0] * 0.32; // horizontal lean per unit length
      ctx.strokeStyle = `rgba(200,214,236,${0.18 + 0.22 * intensity})`;
      ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath();
      for (let i = 0; i < active; i++) {
        const p = rain[i];
        p.y += p.spd * dt;
        p.x += s.windDir[0] * p.spd * 0.32 * dt;
        if (p.y > h) {
          p.y = rnd(-h * 0.2, 0);
          p.x = rnd(0, w);
        }
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - tiltX * p.len, p.y - p.len);
      }
      ctx.stroke();
    };

    const drawLightning = (s: FxState, nowMs: number, dt: number) => {
      if (s.lightning && nowMs >= nextFlashAt) {
        flash = 1;
        nextFlashAt = nowMs + rnd(2500, 8000);
      }
      if (flash > 0.001) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        // a quick double-strobe falloff
        const a = flash * (0.45 + 0.2 * Math.sin(nowMs * 0.06));
        ctx.fillStyle = `rgba(208,222,255,${Math.max(0, a)})`;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
        flash -= dt * 3.2; // ~0.3s decay
        if (flash < 0) flash = 0;
      }
    };

    const frame = () => {
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      timeS += dt;
      const s = fxRef.current;

      ctx.clearRect(0, 0, w, h);
      drawFog(s.haze);
      drawGodRays(s);
      drawSnow(s.snow, dt, s);
      drawRain(s.rain, dt, s);
      drawLightning(s, now, dt);

      raf = requestAnimationFrame(frame);
    };

    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    // The single STATIC ambient frame painted under reduced motion: only the
    // non-moving atmosphere (fog veil + god-rays), no rain/snow/lightning.
    const renderStatic = () => {
      const s = fxRef.current;
      ctx.clearRect(0, 0, w, h);
      drawFog(s.haze);
      drawGodRays(s);
    };

    // prefers-reduced-motion, watched live so a runtime toggle takes effect
    // without remounting the canvas.
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = mq.matches;

    // Reconcile the canvas to the current paused / reduced-motion state: run the
    // loop only when motion is allowed and the scene is visible; otherwise leave
    // the loop stopped (no leaked rAF) and, when reduced, paint one static frame.
    const apply = () => {
      if (pausedRef.current) {
        stop();
        return;
      }
      if (reduced) {
        stop();
        renderStatic();
        return;
      }
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    const redrawStatic = () => {
      if (reduced && !pausedRef.current) renderStatic();
    };

    const onMqChange = () => {
      reduced = mq.matches;
      apply();
    };
    mq.addEventListener("change", onMqChange);

    const ro = new ResizeObserver(() => {
      resize();
      // The loop repaints next frame; a static frame must be redrawn by hand.
      redrawStatic();
    });
    ro.observe(canvas);

    controlRef.current = { apply, redrawStatic };
    apply();

    return () => {
      stop();
      ro.disconnect();
      mq.removeEventListener("change", onMqChange);
      controlRef.current = null;
    };
  }, [quality.tier]);

  // Start/stop on tab visibility without rebuilding the canvas.
  useEffect(() => {
    controlRef.current?.apply();
  }, [paused]);

  // Under reduced motion the loop is idle, so the static frame must be redrawn
  // when the live weather (fog / sun) changes.
  useEffect(() => {
    controlRef.current?.redrawStatic();
  }, [fx]);

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden />;
}
