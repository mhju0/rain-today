"use client";

import { useEffect, useRef, useState } from "react";
import { useSkyImage } from "./SkyImageContext";

/**
 * The still "atmospheric color field" — layer (b) of the retired scene, in place of
 * the video gallery. It renders the single selected landmark plate
 * full-bleed (`object-fit: cover`) and cross-dissolves (~700ms) whenever the
 * condition or time-anchor changes the plate. There is no video machinery: a
 * still needs no buffering, no decode pipeline, no playback rate — just two
 * stacked layers crossfading.
 *
 * Over the plate it stacks the continuous sun-phase grade (tint overlay, a warm
 * golden/city glow, and a night vignette) from {@link useSkyImage} so the
 * time-of-day reads as a smooth gradient across the day on top of whichever
 * anchor plate is showing. When no plate is available (`src === null`) it renders
 * nothing and the procedural CSS field behind shows through — never blank.
 */

const FADE_MS = 700;
let LAYER_SEQ = 0;

export interface ImageFieldProps {
  reducedMotion: boolean;
}

export default function ImageField({ reducedMotion }: ImageFieldProps) {
  const { src, grade } = useSkyImage();
  // Up to two stacked plates: the incoming one fades in over the outgoing, then
  // the outgoing is dropped so only one layer stays decoded.
  const [layers, setLayers] = useState<{ src: string; id: number }[]>([]);
  const dropTimer = useRef<number>(0);

  useEffect(() => {
    if (!src) {
      setLayers([]);
      return;
    }
    setLayers((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].src === src) return prev;
      return [...prev, { src, id: ++LAYER_SEQ }].slice(-2);
    });
    window.clearTimeout(dropTimer.current);
    dropTimer.current = window.setTimeout(() => {
      setLayers((prev) => prev.slice(-1));
    }, FADE_MS + 80);
    return () => window.clearTimeout(dropTimer.current);
  }, [src]);

  if (layers.length === 0) return null; // procedural field shows through

  const pushIn = reducedMotion ? "" : "scene-pushin";
  const entrance = reducedMotion ? "" : "sky-image-in";

  return (
    <div className="absolute inset-0 overflow-hidden">
      {layers.map((layer, i) => (
        <div
          key={layer.id}
          aria-hidden
          className={`sky-image-layer absolute inset-0 h-full w-full ${pushIn} ${
            i === layers.length - 1 ? entrance : ""
          }`}
          style={{
            backgroundImage: `url("${layer.src}")`,
            filter: grade.filter,
          }}
        />
      ))}
      {/* Continuous time-of-day grade, stacked over the plate. */}
      <div className="sky-image-grade absolute inset-0" style={{ background: grade.overlay }} />
      {grade.glow !== "transparent" && (
        <div className="sky-image-grade absolute inset-0" style={{ background: grade.glow }} />
      )}
      <div className="absolute inset-0" style={{ background: grade.vignette }} />
    </div>
  );
}
