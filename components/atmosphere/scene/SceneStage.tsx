"use client";

import dynamic from "next/dynamic";
import { Component, memo, useMemo, type ReactNode } from "react";
import type { QualitySettings } from "@/components/three/quality";
import { selectAtmosphericFieldAdapter } from "@/lib/atmosphere/webglFallback";
import AtmosphericFieldFallback from "../AtmosphericFieldFallback";
import { useWeatherField } from "../WeatherFieldContext";
import FXOverlay, { type FxState } from "./FXOverlay";
import ImageField from "./ImageField";
import { useSkyImage } from "./SkyImageContext";

/**
 * The one persistent SCENE that lives behind the scroll content. It mounts
 * ONCE in the experience shell and never remounts on scroll. The view fills the
 * viewport edge-to-edge — there is no frame around it. Back-to-front:
 *
 *   1. Procedural atmospheric field (WebGL, or a CSS fallback) — the guaranteed
 *      never-blank base. It is always live until a still plate covers it, then it
 *      is paused (it sits fully behind the opaque plate), and it returns the
 *      moment no plate is available. This is the tail of the fallback chain.
 *   2. The still "atmospheric color field" plate, colour-graded by the live sun
 *      phase (the "view") — see {@link ImageField} + {@link useSkyImage}.
 *   3. The live weather FX overlay (rain/snow/lightning/fog/god-rays).
 *
 * Fallback chain (never a blank frame): matching plate → broadened plate (both
 * inside {@link selectSkyImage}) → procedural field here. The plate selection +
 * FX read the single live snapshot from {@link useWeatherField}; capability flags
 * (quality, reduced-motion, tab-hidden, WebGL) come from the shell.
 */

// WebGL field loads client-only (it touches the GL context on mount).
const AtmosphericFieldBackground = dynamic(() => import("../AtmosphericFieldBackground"), {
  ssr: false,
  loading: () => null,
});

/** Swap to the CSS field if the WebGL background throws at runtime. */
class FieldBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export interface SceneStageProps {
  quality: QualitySettings;
  reducedMotion: boolean;
  /** Scene not visible (tab hidden, or covered by the data dashboard) — pause the
   *  FX and procedural field so nothing renders behind it. */
  hidden: boolean;
  pointerEnabled: boolean;
  webgl: boolean;
  canvasFailed: boolean;
  onCanvasError: () => void;
}

function SceneStage({
  quality,
  reducedMotion,
  hidden,
  pointerEnabled,
  webgl,
  canvasFailed,
  onCanvasError,
}: SceneStageProps) {
  const { readout, target } = useWeatherField();
  // The currently-decoded still plate (null → no plate, the procedural field is
  // the scene). It also gates the field pause below.
  const { src: plateSrc } = useSkyImage();

  // Live FX parameters, derived from the same clamped visual target as the field.
  const fx = useMemo<FxState>(
    () => ({
      rain: target.rainDistortion,
      snow: target.snowDensity,
      haze: target.hazeDensity,
      sunPos: target.sunPos,
      sunColor: target.sunColor,
      sunIntensity: target.sunIntensity,
      windDir: target.windDir,
      lightning: readout.condition === "thunderstorm",
    }),
    [target, readout.condition],
  );

  const fieldAdapter = selectAtmosphericFieldAdapter({
    webglSupported: webgl,
    webglFailed: canvasFailed,
  });
  // The field idles whenever a still plate covers it (or the tab is hidden).
  const fieldPaused = hidden || plateSrc != null;

  return (
    <div className="sky-fixed-viewport z-0 bg-[#04060d]">
      {/* 1 — procedural field: the never-blank base + tail of the fallback chain. */}
      <div className="absolute inset-0">
        {fieldAdapter === "css" ? (
          <AtmosphericFieldFallback config={target} reducedMotion={reducedMotion} />
        ) : (
          <FieldBoundary onError={onCanvasError}>
            <AtmosphericFieldBackground
              target={target}
              quality={quality}
              reducedMotion={reducedMotion}
              paused={fieldPaused}
              pointerEnabled={pointerEnabled}
              onFailure={onCanvasError}
            />
          </FieldBoundary>
        )}
      </div>

      {/* 2 — the still Seoul-landmark color-field plate (graded by sun phase). */}
      <ImageField reducedMotion={reducedMotion} />

      {/* 3 — live weather FX. Reduced motion is handled inside the overlay (it
          paints a single static ambient frame), so the layer stays mounted. */}
      <FXOverlay fx={fx} quality={quality} paused={hidden} />
    </div>
  );
}

// Memoized: the shell re-renders every second (live clock), but SceneStage reads
// only the coarse field context and takes referentially-stable props, so the
// still plate + FX no longer re-run their render bodies each tick.
export default memo(SceneStage);
