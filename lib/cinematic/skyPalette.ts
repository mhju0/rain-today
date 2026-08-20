import type { CSSProperties } from "react";
import type { WeatherCondition } from "@/lib/types";

/**
 * The single source of truth for the retired scene's day↔night palette. It turns the
 * continuous sun state into the CSS custom properties that both the fixed
 * scroll-driven gradient layer and every `.sky-panel` read (see globals.css).
 *
 * Two signals drive it, deliberately differently:
 *
 *   • The atmospheric GRADIENT lerps continuously on `dayFactor` (0 night … 1
 *     day) + `goldenFactor` (a warm horizon cast at dawn/dusk), so the backdrop
 *     glides smoothly through blue-hour → golden-hour → daylight.
 *
 *   • The over-scene INK (the hero readout + bare section headings) switches on
 *     the `isDay` boolean instead of lerping. Lerping a light theme into a dark
 *     one necessarily passes through a mid-grey where ink and surface collapse to
 *     the same tone — an unavoidable low-contrast instant. Because legibility is
 *     the priority we snap between two always-high-contrast pairs at the horizon,
 *     where the gradient is already a quiet dusty mid so the change reads as calm.
 *
 *   • The transparent PANEL frames adapt their ink and rim to stay legible
 *     against whatever the cinematic plate is showing. That flip keys off a single
 *     `backdropIsLight` signal — the perceptual luminance of the backdrop base
 *     nudged by weather (snow/fog read bright, storms read dark) — NOT `isDay`,
 *     so a snowy noon gets dark ink while a clear night gets light ink.
 *
 * Palette anchors are the brand colours: deep navy #182350, powder blue
 * #AFD2FA, floral white #FEFAEF, camel #B9915E.
 */

type RGB = readonly [number, number, number];

const NAVY: RGB = [24, 35, 80];    // #182350 — deep navy (day ink, night ground)
const POWDER: RGB = [175, 210, 250]; // #AFD2FA — powder blue (day air bloom)
const CREAM: RGB = [254, 250, 239];  // #FEFAEF — floral white (night ink, day surface)
const CAMEL: RGB = [185, 145, 94];   // #B9915E — warm camel (golden-hour cast)

// Transparent-frame ink — flips on the backdrop-brightness signal (not isDay).
// Tunables: nudge for stronger/softer in-panel contrast.
const PANEL_INK_DARK: RGB = [22, 28, 46];     // dark ink, used over a LIGHT backdrop
const PANEL_INK_LIGHT: RGB = [248, 250, 255]; // near-white ink, used over a DARK backdrop

// Condition tint targets
const SLATE: RGB = [80, 105, 148];  // rain / cool blue-slate
const MIST: RGB = [130, 140, 155];  // fog / overcast grey
const STORM: RGB = [48, 32, 88];    // thunderstorm deep purple

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (a: RGB, b: RGB, t: number): RGB => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

const triplet = (c: RGB) => `${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}`;
const rgb = (c: RGB) => `rgb(${triplet(c)})`;
const rgba = (c: RGB, a: number) => `rgba(${triplet(c)}, ${a})`;

// ---------------------------------------------------------------------------
// Condition-to-tint mapping
// ---------------------------------------------------------------------------

interface ConditionTint {
  /** 0–1: how much to mix toward SLATE (rain/cool blue) */
  cool: number;
  /** 0–1: how much to mix toward MIST (grey/fog) */
  muted: number;
  /** 0–1: how much to mix toward STORM (purple/thunder) */
  storm: number;
  /**
   * Multiplier on base ambient drift durations.
   * >1 = slower (overcast/fog feel); <1 = faster (rain/storm urgency).
   */
  speed: number;
}

// Tunables: adjust cool/muted/storm to dial condition tint strength,
// speed to set per-condition animation pace.
const COND_TINTS: Record<WeatherCondition, ConditionTint> = {
  "clear":          { cool: 0,    muted: 0,    storm: 0,   speed: 1.0  },
  "partly-cloudy":  { cool: 0.08, muted: 0.04, storm: 0,   speed: 1.05 },
  "cloudy":         { cool: 0.18, muted: 0.18, storm: 0,   speed: 1.1  },
  "overcast":       { cool: 0.22, muted: 0.32, storm: 0,   speed: 1.2  },
  "fog":            { cool: 0.1,  muted: 0.45, storm: 0,   speed: 1.3  },
  "drizzle":        { cool: 0.22, muted: 0.12, storm: 0,   speed: 0.88 },
  "rain":           { cool: 0.32, muted: 0.14, storm: 0,   speed: 0.82 },
  "heavy-rain":     { cool: 0.42, muted: 0.18, storm: 0,   speed: 0.76 },
  "snow":           { cool: 0.28, muted: 0.08, storm: 0,   speed: 1.15 },
  "sleet":          { cool: 0.28, muted: 0.18, storm: 0,   speed: 0.92 },
  "thunderstorm":   { cool: 0.15, muted: 0.12, storm: 0.7, speed: 0.72 },
  "unknown":        { cool: 0,    muted: 0,    storm: 0,   speed: 1.0  },
};

// Signed brightness bias added to the backdrop's base luminance before
// thresholding the `backdropIsLight` panel-ink signal. Hazy/bright weather
// (snow, fog, overcast) reads lighter than its base tone; storms/heavy-rain read
// darker. It mostly matters near the dawn/dusk threshold; deep night stays dark
// and full noon stays light regardless.
// Tunables: push a condition's value to shift where its panel ink flips.
const COND_BRIGHTNESS: Record<WeatherCondition, number> = {
  "clear":          0,
  "partly-cloudy":  0.02,
  "cloudy":         0.05,
  "overcast":       0.06,
  "fog":            0.10,
  "drizzle":        -0.02,
  "rain":           -0.05,
  "heavy-rain":     -0.08,
  "snow":           0.14,
  "sleet":          0.04,
  "thunderstorm":   -0.10,
  "unknown":        0,
};

// Base ambient drift durations in seconds for the 4 independent blooms.
// Tunables: increase for a more languid field, decrease for more energy.
const AMB_BASE_DURS = [38, 52, 44, 61] as const;

// Base breathing cycle duration in seconds (near-full cycle, ease-in-out alternate).
// Tunables: 6s = fast breath, 14s = very slow sigh.
const AMB_BREATH_BASE = 9;

function applyCondTint(base: RGB, t: ConditionTint): RGB {
  return mix(mix(mix(base, SLATE, t.cool), MIST, t.muted), STORM, t.storm);
}

// ---------------------------------------------------------------------------
// Main palette builder
// ---------------------------------------------------------------------------

/**
 * Build the CSS custom properties for the current sky. Returns a `style` object
 * to spread onto the `.sky-foreground` wrapper; globals.css consumes every var.
 *
 * `condition` drives the ambient bloom tints and drift speeds so the living
 * sky field reflects the weather: warm slow glow on clear days, diffuse cool
 * drift when overcast, deeper urgency in rain and storms.
 */
export function buildSkyPalette(
  isDay: boolean,
  dayFactor: number,
  goldenFactor: number,
  condition: WeatherCondition = "unknown",
): CSSProperties {
  const d = clamp01(dayFactor);
  const g = clamp01(goldenFactor);

  // --- Continuous atmospheric gradient (lerp on dayFactor) -----------------
  const base = mix([12, 18, 38], [250, 244, 232], d);

  const bloomA = `radial-gradient(58% 54% at 19% 16%, ${rgba(
    mix([58, 82, 140], POWDER, d),
    lerp(0.34, 0.6, d),
  )}, transparent 62%)`;

  const bloomC = `radial-gradient(54% 52% at 84% 6%, ${rgba(
    mix([30, 42, 86], [255, 252, 245], d),
    lerp(0.32, 0.62, d),
  )}, transparent 60%)`;

  const warmBody = mix(mix([34, 36, 66], [243, 224, 197], d), CAMEL, g * 0.55);
  const bloomB = `radial-gradient(76% 66% at 50% 113%, ${rgba(
    warmBody,
    lerp(0.3, 0.55, d) + g * 0.18,
  )}, transparent 60%)`;

  // --- Over-scene ink (switch on isDay) ------------------------------------
  // The hero readout + bare section headings. Unchanged — only the PANEL ink
  // below follows the backdrop-brightness signal.
  const ink = isDay ? NAVY : CREAM;

  // --- Backdrop-brightness signal → frame contrast + ink flip --------------
  // Perceptual luminance of the computed backdrop base (which tracks the sun via
  // dayFactor), nudged by the weather so snow/fog read bright and storms read
  // dark. This single boolean decides the frame's contrast + ink so
  // nothing inside ever disappears against the plate.
  const baseLum = (base[0] * 0.299 + base[1] * 0.587 + base[2] * 0.114) / 255;
  const backdropIsLight = baseLum + COND_BRIGHTNESS[condition] > 0.5;

  // --- Transparent panel frame ---------------------------------------------
  // The container fill is fixed to transparent in globals.css. This palette
  // supplies adaptive ink, rim, depth, and a small contrast halo token used by
  // internal controls such as the radar playhead.
  const panelInk = backdropIsLight ? PANEL_INK_DARK : PANEL_INK_LIGHT;
  const panelBg = backdropIsLight
    ? "rgba(248, 250, 255, 0.20)"  // light smoky tint over a bright backdrop
    : "rgba(12, 16, 30, 0.26)";    // dark smoky tint over a dark backdrop
  const panelBorder = backdropIsLight
    ? "rgba(255, 255, 255, 0.50)"  // crisp bright rim still pops on a light sky
    : "rgba(255, 255, 255, 0.22)"; // luminous rim on a dark sky
  const panelShadow = backdropIsLight
    ? "inset 0 1px 0 rgba(255,255,255,0.70), inset 0 -1px 0 rgba(255,255,255,0.12), 0 22px 50px -26px rgba(24,35,80,0.30)"
    : "inset 0 1px 0 rgba(255,255,255,0.45), inset 0 -1px 0 rgba(255,255,255,0.06), 0 22px 52px -24px rgba(0,0,0,0.62)";
  // --- Ambient living-sky bloom colors (per-condition + day/night) ---------
  const tint = COND_TINTS[condition];
  const fogDamp = condition === "fog" ? 0.65 : 1;

  // Bloom A — top-left powder / cobalt-blue: the main air bloom.
  // Night floor raised to a brighter cobalt so it reads behind navy panels.
  // Tunables: night base [R,G,B] → push toward higher values for more luminosity.
  const ambBaseA = mix([90, 130, 210], POWDER, d);
  const ambColA = applyCondTint(ambBaseA, tint);
  const ambOpA = lerp(0.50, 0.56, d) * fogDamp; // night floor 0.30→0.50

  // Bloom B — bottom horizon: violet-depth at night, warm cream by day.
  // Night pushes toward deep violet so the ground reads as a different hue from A/C.
  // Tunables: night base [R,G,B] for the warm-vs-cool split at the horizon.
  const ambBaseB = mix(mix([72, 35, 105], [243, 224, 197], d), CAMEL, g * 0.55);
  const ambColB = applyCondTint(ambBaseB, tint);
  const ambOpB = (lerp(0.42, 0.5, d) + g * 0.15) * fogDamp; // night floor 0.26→0.42

  // Bloom C — top-right highlight: lifted cobalt corner.
  // Tunables: night base [R,G,B] controls corner luminosity.
  const ambBaseC = mix([62, 98, 190], [255, 252, 245], d);
  const ambColC = applyCondTint(ambBaseC, tint);
  const ambOpC = lerp(0.44, 0.55, d) * fogDamp; // night floor 0.26→0.44

  // Bloom D — mid-right accent: a secondary cross-modal glow.
  // Day → warm cream; night → vivid indigo; storm → deep purple accent.
  // Tunables: ambBaseDNight controls the indigo saturation at night.
  const ambBaseDDay: RGB = [210, 198, 172];
  const ambBaseDNight: RGB = [68, 52, 168];
  const ambBaseD = mix(ambBaseDNight, ambBaseDDay, d);
  const ambColD = applyCondTint(ambBaseD, tint);
  const ambOpD = lerp(0.30, 0.20, d) * fogDamp; // night floor 0.13→0.30 (night > day)

  // Drift durations — scaled by condition speed factor.
  // Tunables: edit AMB_BASE_DURS to shift all bloom speeds together,
  //           or COND_TINTS[cond].speed to adjust per-condition pace.
  const sf = tint.speed;
  const [durA, durB, durC, durD] = AMB_BASE_DURS.map((s) => `${Math.round(s * sf)}s`);

  // Breathing cycle — fog/overcast breathes slower; storm breathes faster.
  // Tunables: adjust AMB_BREATH_BASE (base seconds) and the lerp weights below.
  const breathDur =
    condition === "fog" || condition === "overcast"
      ? `${AMB_BREATH_BASE + 4}s`
      : condition === "thunderstorm"
        ? `${Math.round(AMB_BREATH_BASE * 0.7)}s`
        : `${AMB_BREATH_BASE}s`;

  return {
    ["--color-white" as string]: rgb(ink),
    // Transparent-frame ink — re-scoped onto --color-white inside .sky-panel so
    // every text-white/*, bg-white/* and currentColor descendant flips with the
    // backdrop. Kept separate from the over-scene --color-white above.
    ["--sky-panel-ink" as string]: rgb(panelInk),
    // A small internal-control halo only; top-level surfaces never consume it.
    ["--sky-panel-bg" as string]: panelBg,
    ["--sky-panel-border" as string]: panelBorder,
    ["--sky-panel-shadow" as string]: panelShadow,
    // Capsule rounding for every .sky-panel (overridable per-card via the
    // GlassPanel `radius` prop, which emits a Tailwind utility that wins).
    ["--sky-panel-radius" as string]: "28px",
    ["--sky-bg-base" as string]: rgb(base),
    // Legacy gradient vars — kept for any external references.
    ["--sky-bloom-a" as string]: bloomA,
    ["--sky-bloom-b" as string]: bloomB,
    ["--sky-bloom-c" as string]: bloomC,
    // Ambient multi-bloom system (consumed by .sky-amb-bloom-* in globals.css).
    ["--sky-amb-col-a" as string]: rgba(ambColA, ambOpA),
    ["--sky-amb-col-b" as string]: rgba(ambColB, ambOpB),
    ["--sky-amb-col-c" as string]: rgba(ambColC, ambOpC),
    ["--sky-amb-col-d" as string]: rgba(ambColD, ambOpD),
    // Drift durations — writable CSS vars so you can override from DevTools.
    ["--sky-amb-dur-a" as string]: durA,
    ["--sky-amb-dur-b" as string]: durB,
    ["--sky-amb-dur-c" as string]: durC,
    ["--sky-amb-dur-d" as string]: durD,
    ["--sky-amb-breath-dur" as string]: breathDur,
  } as CSSProperties;
}

// ---------------------------------------------------------------------------
// Still-image time grade
// ---------------------------------------------------------------------------

/**
 * The CSS recipe that colour-grades a still atmospheric plate to the live moment.
 * The {@link ImageField} applies `filter` to the plate and stacks `overlay`,
 * `glow` and `vignette` over it. Everything is continuous in the sun phase, so the
 * scene glides through the day rather than snapping at anchor boundaries — the
 * anchor switch (see skyImageField.ts) only swaps the base plate; this grade
 * carries the smooth pre-dawn → morning → noon → golden → sunset → blue-hour →
 * night arc on top of whichever anchor is showing.
 */
export interface ImageGrade {
  /** `filter` for the plate itself (exposure / contrast / saturation). */
  filter: string;
  /** A full-bleed tint wash (time-of-day + condition colour cast). */
  overlay: string;
  /** A warm radial bloom (golden hour + a faint night city-glow), or "transparent". */
  glow: string;
  /** A radial edge-darkening that deepens at night. */
  vignette: string;
}

/**
 * Build the grade for the current sky.
 *
 * `rising` separates dawn from dusk (they share a `dayFactor` but read very
 * differently — cool indigo before sunrise vs a warm city cast after sunset);
 * `elevation` (−1 solar midnight … +1 noon) deepens the darkest hours. `condition`
 * pulls the whole grade grey/cool and damps the glow when overcast/foggy/wet.
 */
export function buildImageGrade(
  dayFactor: number,
  goldenFactor: number,
  rising: boolean,
  elevation: number,
  condition: WeatherCondition = "unknown",
): ImageGrade {
  const d = clamp01(dayFactor);
  const g = clamp01(goldenFactor);
  const t = COND_TINTS[condition];
  const nightDepth = clamp01(-elevation); // 0 at the horizon → 1 at solar midnight

  // --- Per-anchor grade params (the one place to tune the look) ---------------
  // Night side: pre-dawn is a cool deep indigo; evening keeps a warm city cast.
  const NIGHT_COOL: RGB = [26, 34, 82];
  const NIGHT_WARM: RGB = [44, 32, 60];
  // Horizon side: gold at sunrise, orange-magenta fire at sunset.
  const SUNRISE_GOLD: RGB = [226, 170, 98];
  const SUNSET_FIRE: RGB = [214, 96, 92];
  // Noon air: a faint cool neutral so daylight reads clean, not tinted.
  const DAY_NEUTRAL: RGB = [150, 172, 208];
  const GLOW_WARM: RGB = [255, 192, 122];

  // --- Exposure (filter on the plate) ----------------------------------------
  let brightness = lerp(0.62, 1.05, d) - nightDepth * (1 - d) * 0.06;
  brightness *= lerp(1, 0.93, t.muted); // overcast/fog sit a touch darker
  const saturate = lerp(0.9, 1.08, d) * (1 - t.cool * 0.22) * (1 - t.muted * 0.3);
  const contrast = lerp(0.96, 1.03, d);
  const filter = `brightness(${brightness.toFixed(3)}) contrast(${contrast.toFixed(3)}) saturate(${saturate.toFixed(3)})`;

  // --- Time-of-day tint overlay ----------------------------------------------
  const nightTint = rising ? NIGHT_COOL : NIGHT_WARM;
  const horizonTint = rising ? SUNRISE_GOLD : SUNSET_FIRE;
  let tone = mix(nightTint, DAY_NEUTRAL, d); // night → day base
  tone = mix(tone, horizonTint, g * 0.8); // warm horizon cast at the anchor edge
  tone = mix(mix(tone, SLATE, t.cool * 0.4), MIST, t.muted * 0.5); // weather pull
  const overlayAlpha = (lerp(0.3, 0.07, d) + g * 0.12) * lerp(1, 0.85, t.muted);
  const overlay = rgba(tone, overlayAlpha);

  // --- Glow: golden-hour bloom + a faint night city-glow ---------------------
  const glowAlpha = (g * 0.24 + (1 - d) * 0.05) * (1 - t.muted);
  const glow =
    glowAlpha > 0.012
      ? `radial-gradient(62% 50% at 50% ${Math.round(lerp(80, 92, g))}%, ${rgba(
          GLOW_WARM,
          glowAlpha,
        )}, transparent 70%)`
      : "transparent";

  // --- Vignette: deepens at night, opens up by day ---------------------------
  const vigAlpha = lerp(0.46, 0.12, d) + nightDepth * (1 - d) * 0.08;
  const vignette = `radial-gradient(125% 108% at 50% 46%, transparent 52%, rgba(3, 5, 12, ${vigAlpha.toFixed(
    3,
  )}) 100%)`;

  return { filter, overlay, glow, vignette };
}
