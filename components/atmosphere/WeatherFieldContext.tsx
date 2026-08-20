"use client";

import { createContext, useContext } from "react";
import type { WeatherStatus } from "@/hooks/useLiveSeoulWeather";
import type { AtmosphereReadout, VisualConfig } from "@/lib/atmosphere/weatherVisualConfig";
import type { SkySnapshot } from "@/lib/types";

/**
 * Live state shared by every view rendered inside the {@link WeatherExperienceShell}.
 * The shell fetches Seoul weather once and computes the visual target + readout;
 * AtmosphereView and DiagnosticsView read from here instead of re-fetching, so
 * the two routes drive the SAME atmospheric field from a single data source.
 *
 * This value updates only on a coarse cadence (weather refresh + the ~30s visual
 * tick), NOT every second — the live per-second clock lives in its own
 * {@link WeatherClockContext} so that consumers which only need the slow state
 * (e.g. the SceneStage, which derives the day/night flag) don't re-render every
 * tick. Components that actually display ticking time subscribe to the clock.
 */
export interface WeatherFieldValue {
  snapshot: SkySnapshot | null;
  status: WeatherStatus;
  lastUpdatedAt: number | null;
  readout: AtmosphereReadout;
  /** The current clamped visual target (also exposes the weather accent colour). */
  target: VisualConfig;
  /** Day/night flag from Seoul sun geometry, recomputed on the coarse tick. */
  isDay: boolean;
  /** Continuous 0 (full night) … 1 (full day) — drives the gradient colour lerp. */
  dayFactor: number;
  /** 0 … 1 warm bump around the horizon — drives the gradient's golden-hour cast. */
  goldenFactor: number;
  /** Sun ascending (before solar noon) — separates dawn's cool cast from dusk's warm one. */
  rising: boolean;
  /** Sun-altitude proxy −1 (solar midnight) … +1 (noon) — deepens the darkest hours. */
  elevation: number;
}

const WeatherFieldContext = createContext<WeatherFieldValue | null>(null);

export const WeatherFieldProvider = WeatherFieldContext.Provider;

export function useWeatherField(): WeatherFieldValue {
  const v = useContext(WeatherFieldContext);
  if (!v) throw new Error("useWeatherField must be used inside <WeatherExperienceShell>");
  return v;
}

/**
 * The live Seoul clock instant (or `null` before the first client tick), split
 * into its own context because it changes every second. Only components that
 * render ticking time should subscribe — subscribing here re-renders the
 * consumer per second, which is why the heavy scene reads {@link useWeatherField}
 * (coarse) instead.
 */
const WeatherClockContext = createContext<Date | null>(null);

export const WeatherClockProvider = WeatherClockContext.Provider;

export function useWeatherClock(): Date | null {
  return useContext(WeatherClockContext);
}

/**
 * Which of the two discrete scene views is showing — the full-screen live "hero"
 * (video + minimal readout) or the scrolling "data" dashboard. The shell owns the
 * state and flips it from the keyboard (D toggles, Esc → hero); {@link SkyView}
 * reads it here to cross-fade the two layers, and the shell uses it to pause the
 * scene while the dashboard is up.
 */
export type WeatherView = "hero" | "data";

const WeatherViewContext = createContext<WeatherView>("hero");

export const WeatherViewProvider = WeatherViewContext.Provider;

export function useWeatherView(): WeatherView {
  return useContext(WeatherViewContext);
}

/**
 * The shell-owned toggle that flips hero ↔ data — the SAME callback the desktop
 * D key fires. Exposed via context so the on-screen "데이터 · explore" affordance
 * in {@link SkyView} can drive the view on touch (where there is no keyboard),
 * without duplicating the state logic. Defaults to a no-op outside a provider.
 */
const WeatherViewToggleContext = createContext<() => void>(() => {});

export const WeatherViewToggleProvider = WeatherViewToggleContext.Provider;

export function useWeatherViewToggle(): () => void {
  return useContext(WeatherViewToggleContext);
}
