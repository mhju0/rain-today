"use client";

import type { ReactNode } from "react";

/**
 * A frameless reading surface used across the scene HUD. It has no fill, border or
 * shadow — content sits etched directly over the cinematic scene, matching the
 * other data sections. Its remaining job is to re-scope `--color-white` to the
 * adaptive `--sky-panel-ink` (via `.sky-panel` in globals.css) so descendant text
 * and glyphs flip legibly with the backdrop.
 *
 * The name and prop API are unchanged so every call site keeps working as-is.
 *
 * Radius: with no `radius` prop the panel inherits the capsule `--sky-panel-radius`
 * token; pass a Tailwind radius class to override it per card.
 */
export default function GlassPanel({
  children,
  className = "",
  radius,
  elevated = false,
}: {
  children: ReactNode;
  className?: string;
  /** Tailwind radius class to override the capsule token for one card. */
  radius?: string;
  /** Adds a desktop hover lift without adding a background fill. */
  elevated?: boolean;
}) {
  return (
    <div className={`sky-panel ${elevated ? "sky-panel-elevated" : ""} ${radius ?? ""} ${className}`}>
      {children}
    </div>
  );
}
