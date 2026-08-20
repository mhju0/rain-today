"use client";

import { buildSkyPalette } from "@/lib/cinematic/skyPalette";
import { useSkyImage } from "./scene/SkyImageContext";
import ArrivalSection from "./sections/ArrivalSection";
import ForecastSection from "./sections/ForecastSection";
import GroundStationSection from "./sections/GroundStationSection";
import InstrumentsSection from "./sections/InstrumentsSection";
import RadarSection from "./sections/RadarSection";
import { useWeatherField, useWeatherView, useWeatherViewToggle } from "./WeatherFieldContext";

/**
 * The readable HUD over the live scene. Two discrete, keyboard-toggled
 * views share the viewport (desktop only): D toggles between them, Esc returns to
 * the hero — the state lives in {@link WeatherExperienceShell}.
 *
 *   • Hero — the full-screen live view (the still landmark plate on the fixed
 *     SceneStage below) with the de-glassed Arrival readout floating over it and a
 *     subtle "press D" hint. No scroll.
 *   • Data — the rest of the dashboard (현재 날씨 → forecast → radar → ground station)
 *     in a self-contained scrolling container with its own opaque day/night
 *     gradient backdrop, so nothing heavy renders behind it (the scene is paused).
 *
 * Both layers are always mounted and cross-fade in place on the toggle (~500ms,
 * pure opacity — no slide/zoom), so the only transition is the D-toggle and there
 * is no scroll-coupled opacity. Because the data backdrop is the hero plate at
 * identical geometry (only blurred), the D-toggle reads as the SAME scene blurring
 * where it sits — co-registered, no jump.
 *
 * The whole foreground is wrapped so the day/night palette ({@link buildSkyPalette})
 * applies as CSS variables once, here: the gradient colours, the panel surfaces,
 * and a remap of Tailwind's `white` so existing `text-white/*` becomes the correct
 * ink for the current sky.
 */
export default function SkyView() {
  const { isDay, dayFactor, goldenFactor, readout } = useWeatherField();
  const { src: plateSrc } = useSkyImage();
  const view = useWeatherView();
  const toggleView = useWeatherViewToggle();
  const isHero = view === "hero";

  return (
    <div className="sky-foreground" style={buildSkyPalette(isDay, dayFactor, goldenFactor, readout.condition)}>
      {/* Hero layer — the de-glassed Arrival readout over the live view. */}
      <div
        className={`sky-hero-layer text-white ${isHero ? "is-active" : ""}`}
        aria-hidden={!isHero}
        inert={!isHero}
      >
        <ArrivalSection />

        {/* The navigation affordance. Doubles as the touch entry point to the data
            deck (no keyboard on mobile): a real button firing the SAME shell toggle
            the D key calls. The full-width bar stays click-through; only the button
            itself captures taps, with generous padding for a comfortable hit area. */}
        <div className="sky-on-media pointer-events-none absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+1.25rem)] z-10 flex items-center justify-center sm:bottom-[clamp(1.75rem,5vh,3.25rem)]">
          <button
            type="button"
            onClick={toggleView}
            aria-label="상세 날씨 보기 (D 키)"
            className="group pointer-events-auto flex min-h-11 items-center gap-2.5 rounded-full px-4 py-2.5 transition-colors hover:bg-white/5 active:translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40"
          >
            <span className="h-px w-8 bg-white/45 transition-all duration-300 group-hover:w-12" />
            <span className="font-sans text-[12px] font-medium tracking-[0.16em] text-white/72">
              상세 날씨 보기
            </span>
            {/* Desktop-only keycap for the D shortcut (there is no keyboard on
                mobile, where the tap itself is the affordance). Replaces the old
                ↓ arrow, which read as "scroll" when the action is a view toggle. */}
            <kbd
              aria-hidden
              className="hidden h-[1.35rem] min-w-[1.35rem] items-center justify-center rounded-[5px] border border-white/30 px-1.5 font-sans text-[11px] font-medium leading-none text-white/60 transition-colors group-hover:border-white/45 group-hover:text-white/85 sm:inline-flex"
            >
              D
            </kbd>
          </button>
        </div>
      </div>

      {/* Data layer — the scrolling dashboard with its own gradient backdrop. */}
      <div
        className={`sky-data-layer ${!isHero ? "is-active" : ""}`}
        aria-hidden={isHero}
        inert={isHero}
      >
        {/* Data backdrop. When a still plate is showing it is reused here at the
            EXACT geometry of the hero plate (inset 0, cover, centred, same
            scene-pushin) — only blurred + darkened behind the data grid — so the
            D-toggle blurs the SAME co-registered scene in place, no shift. With no
            plate (the procedural fallback) it shows the ambient sky field: 4 independently drifting
            colour blooms + a breathing veil + animated matte grain. All layers
            fade with the data layer so the scene behind never shows through. */}
        <div aria-hidden className="sky-data-bg pointer-events-none">
          {plateSrc ? (
            <>
              <div className="sky-data-plate scene-pushin" style={{ backgroundImage: `url("${plateSrc}")` }} />
              <div className="sky-data-scrim" />
            </>
          ) : (
            <>
              <div className="sky-amb-base" />
              <div className="sky-amb-bloom sky-amb-bloom-a" />
              <div className="sky-amb-bloom sky-amb-bloom-b" />
              <div className="sky-amb-bloom sky-amb-bloom-c" />
              <div className="sky-amb-bloom sky-amb-bloom-d" />
              <div className="sky-amb-breath" />
              <div className="sky-grain" />
            </>
          )}
        </div>

        <div className="sky-data-scroll scroll-thin">
          <div className="relative z-10 text-white">
            <InstrumentsSection />
            <ForecastSection />
            <RadarSection />
            <GroundStationSection />
          </div>
        </div>

        {/* Return-to-hero affordance — the touch counterpart to the desktop Esc
            key, so mobile users (no keyboard) can leave the data deck. Fires the
            SAME shell toggle the D key calls; from the data view it returns to the
            hero. Pinned to the top-start of the viewport (it does not scroll with
            the deck) and inert with the whole data layer while the hero shows. The
            ESC hint only appears where a keyboard exists (sm+). */}
        <button
          type="button"
          onClick={toggleView}
          aria-label="처음 화면으로"
          className="absolute right-[clamp(1.25rem,4vw,3.25rem)] top-[clamp(1rem,3.2vh,1.9rem)] z-20 inline-flex h-11 w-11 items-center justify-center gap-2 rounded-full border border-white/20 bg-white/10 backdrop-blur-md transition-all duration-200 hover:bg-white/20 active:translate-y-px sm:h-auto sm:w-auto sm:px-4 sm:py-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/50"
        >
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="h-4 w-4 text-white"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
          <span className="hidden font-sans text-[11px] font-medium tracking-[0.14em] text-white sm:inline">처음으로</span>
        </button>
      </div>
    </div>
  );
}
