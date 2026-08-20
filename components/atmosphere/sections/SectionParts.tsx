"use client";

import type { ReactNode } from "react";
import type { WeatherStatus } from "@/hooks/useLiveSeoulWeather";

/**
 * Shared chrome for the four scroll sections — the section shell, the quiet
 * KO·EN heading, and the live-status badge. Pure presentation; the panels and the
 * data live in the section bodies. Every section flows in the normal document
 * scroll over the fixed scene, so reveal/parallax here never drives the scene.
 */

/** One full-height scroll section with the shared reading gutter. */
export function SkySection({
  id,
  children,
  center = false,
  compact = false,
  className = "",
}: {
  id?: string;
  children: ReactNode;
  /** Vertically centre the content (the arrival hero); else top-align. */
  center?: boolean;
  /** Tighter vertical rhythm for dense data sections on laptop-height screens. */
  compact?: boolean;
  className?: string;
}) {
  const padding = center
    ? "justify-center py-[clamp(3rem,12vh,8rem)]"
    : compact
      ? "justify-start py-[clamp(3.5rem,8vh,6rem)]"
      : "justify-start py-[clamp(5rem,11vh,8rem)]";

  return (
    <section
      id={id}
      className={`relative flex min-h-svh w-full scroll-mt-0 flex-col px-[clamp(1.25rem,4vw,3.25rem)] ${padding} ${className}`}
    >
      {children}
    </section>
  );
}

/** A direct section title with a quiet numeric index. */
export function SectionHeading({
  index,
  title,
  compact = false,
}: {
  index: string;
  title: string;
  compact?: boolean;
}) {
  return (
    <div className={`sky-data-heading ${compact ? "mb-11" : "mb-14"} flex max-w-3xl items-start gap-4 sm:gap-5`}>
      <span className="mt-1.5 font-mono text-[11px] font-medium tabular-nums tracking-[0.12em] text-white/65">
        {index}
      </span>
      <h2 className="m-0 break-keep font-sans text-[clamp(1.75rem,2.5vw,2.5rem)] font-semibold leading-tight tracking-[-0.04em] text-white">
        {title}
      </h2>
    </div>
  );
}

/** Live / cached / syncing badge with a pulsing dot, reused by arrival + ground.
 * `labelClassName` overrides the label's text size at the call site (arrival sizes
 * it up to sit with its larger header). */
export function LiveBadge({
  status,
  labelClassName = "text-[10px]",
}: {
  status: WeatherStatus;
  labelClassName?: string;
}) {
  const label = status === "live" ? "실시간" : status === "error" ? "저장된 관측" : "관측 갱신 중";
  const dot = status === "live" ? "bg-emerald-300" : status === "error" ? "bg-amber-300" : "bg-white/60";
  return (
    <span className="flex items-center gap-2">
      <span
        className={`h-1.5 w-1.5 rounded-full ${dot} ${
          status !== "error" ? "animate-pulse" : ""
        }`}
      />
      <span className={`font-sans font-medium tracking-[0.12em] text-white/70 ${labelClassName}`}>{label}</span>
    </span>
  );
}
