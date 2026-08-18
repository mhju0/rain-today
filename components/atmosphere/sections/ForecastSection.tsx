"use client";

import { dayLabel, makeIsNightAt } from "@/lib/format";
import { buildForecastBlocks } from "@/lib/forecast/blocks";
import type { WeatherCondition } from "@/lib/types";
import WeatherGlyph from "../glass/WeatherGlyph";
import { MetricLabel } from "../EtchedType";
import { ScrollReveal } from "../descentMotion";
import { useWeatherField } from "../WeatherFieldContext";
import { SectionHeading, SkySection } from "./SectionParts";

/**
 * Section 3 — Forecast. A full-screen, rain-forward read of the hours just ahead
 * and the week ahead. The shared sky snapshot already carries the hourly + daily
 * series (incl. Open-Meteo precip probability), so this reads from context with no
 * extra fetch. Two full-width strips sharing one bordered-grid treatment (the
 * same idiom as 현재 날씨 above, so the sections align edge-to-edge): the next
 * ~24 hours folded into eight wide, no-scroll blocks (지금 → 새벽/아침/…) by
 * {@link buildForecastBlocks}, and the 7-day row as seven equal cards, each
 * carrying 강수확률 (POP) alongside the condition + temperatures.
 */

/** Probability → indicator tint, graduating from a faint sky to a saturated
 *  blue so heavier rain chances read louder across the strip and the week row. */
function popTint(pop: number | null): string {
  if (pop == null) return "bg-white/15";
  if (pop < 20) return "bg-sky-300/45";
  if (pop < 50) return "bg-sky-400/75";
  return "bg-blue-400/90";
}

const clampPct = (pop: number | null) => (pop == null ? 0 : Math.max(0, Math.min(100, pop)));

/**
 * Presentation-only reconciliation of the forecast glyph with its POP. Open-Meteo's
 * `weather_code` is the modal/most-likely sky state while POP is a probability (a max
 * aggregate for the daily row), so a dry code can legitimately pair with a high rain
 * chance — leaving a ☀️ glyph beside "86%". When the chance is at least even (≥50%)
 * we upgrade a *dry* face (clear / partly-cloudy only) to the existing "rain" glyph so
 * the icon no longer contradicts the number. All other conditions — cloudy/overcast
 * (already non-sunny) and every precip/snow/thunder face — pass through untouched, and
 * no POP number, bar, or text is changed. This stays inside the forecast cards: it does
 * not touch WeatherGlyph, fusion, or the KMA-anchored live scene. */
function glyphCondition(condition: WeatherCondition, pop: number | null): WeatherCondition {
  if (pop != null && pop >= 50 && (condition === "clear" || condition === "partly-cloudy")) {
    return "rain";
  }
  return condition;
}

const TEMP_LABEL = { high: "최고", low: "최저" } as const;

export default function ForecastSection() {
  const { snapshot, readout } = useWeatherField();

  const blocks = buildForecastBlocks(snapshot?.hourly ?? []);
  const daily = (snapshot?.daily ?? []).slice(0, 7);
  // Per-hour day/night for the icon face, from the daily sun times (fixed-hour
  // fallback inside makeIsNightAt when a provider has none).
  const isNightAt = makeIsNightAt(snapshot?.daily ?? []);

  return (
    <SkySection id="flow" compact>
      <SectionHeading
        index="03"
        title="시간별·7일 날씨"
        compact
      />

      <div className="mx-auto flex w-full max-w-[80rem] flex-1 flex-col justify-center gap-10 sm:gap-12">
        <ScrollReveal amount={0.12}>
          <MetricLabel tone="bright" className="mb-4 px-1">시간별 날씨</MetricLabel>
          {blocks.length > 0 ? (
            <div className="scroll-thin overflow-x-auto border-y border-white/18">
              <ol
                className="grid min-w-[64rem] grid-cols-8"
                aria-label="시간대별 예보 — 기온 및 강수확률"
              >
                {blocks.map((b, i) => {
                  const pct = clampPct(b.precipMax);
                  return (
                    <li
                      key={b.representativeTime}
                      className="relative flex min-h-[15rem] flex-col justify-between border-l border-white/14 px-4 py-5 first:border-l-0"
                    >
                      <div>
                        <span className="sky-display text-2xl text-white">{b.label}</span>
                        <span className="mt-1 block font-mono text-[10px] tracking-[0.08em] text-white/65">
                          {b.rangeLabel}
                        </span>
                      </div>
                      <WeatherGlyph
                        condition={i === 0 ? readout.condition : glyphCondition(b.condition, b.precipMax)}
                        night={isNightAt(b.representativeTime)}
                        size={36}
                        className="text-white"
                      />
                      <div>
                        <div className="flex items-baseline gap-2 font-sans tabular-nums">
                          <span className="text-2xl font-light text-white">{b.tempHigh}°</span>
                          <span className="text-sm font-light text-white/65">{b.tempLow}°</span>
                        </div>
                        <div className="mt-3 flex items-center justify-between gap-2">
                          <span className="text-[11px] text-white/60">비</span>
                          <span className="font-mono text-xs tabular-nums text-white">
                            {b.precipMax == null ? "—" : `${Math.round(pct)}%`}
                          </span>
                        </div>
                      </div>
                      <span
                        aria-hidden
                        className={`absolute inset-x-0 bottom-0 h-1 origin-left ${popTint(b.precipMax)}`}
                        style={{ transform: `scaleX(${pct / 100})` }}
                      />
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : (
            <p className="font-sans text-sm tracking-[0.1em] text-white/75">
              시간별 예보를 불러오는 중입니다.
            </p>
          )}
        </ScrollReveal>

        {daily.length > 0 && (
          <ScrollReveal amount={0.12} delay={0.06}>
            <MetricLabel tone="bright" className="mb-4 px-1">7일 날씨</MetricLabel>
            <div className="scroll-thin overflow-x-auto border-y border-white/18">
              <ol className="grid min-w-[48rem] grid-cols-7">
                {daily.map((d) => (
                  <li
                    key={d.date}
                    className="relative flex flex-col gap-4 border-l border-white/12 px-4 py-5 pb-6 first:border-l-0"
                  >
                    <span className="sky-display text-lg text-white">{dayLabel(d.date)}</span>
                    <WeatherGlyph
                      condition={glyphCondition(d.condition, d.precipitationProbability)}
                      size={30}
                      className="text-white"
                    />
                    <span className="flex items-baseline gap-2 font-sans tabular-nums">
                      <span className="text-xl font-light text-white">
                        <span className="mr-1 text-[10px] text-white/55">{TEMP_LABEL.high}</span>
                        {Math.round(d.temperatureMax)}°
                      </span>
                      <span className="text-sm font-light text-white/62">
                        <span className="mr-1 text-[9px]">{TEMP_LABEL.low}</span>
                        {Math.round(d.temperatureMin)}°
                      </span>
                    </span>
                    <span className="font-mono text-[11px] tabular-nums text-white/75">
                      비 {d.precipitationProbability == null ? "—" : `${Math.round(d.precipitationProbability)}%`}
                    </span>
                    {/* POP bar over the row's bottom border — same construction as
                        the hourly strip above, so both rows read as one system. */}
                    <span
                      aria-hidden
                      className={`absolute inset-x-0 bottom-0 h-1 origin-left ${popTint(d.precipitationProbability)}`}
                      style={{ transform: `scaleX(${clampPct(d.precipitationProbability) / 100})` }}
                    />
                  </li>
                ))}
              </ol>
            </div>
          </ScrollReveal>
        )}
      </div>
    </SkySection>
  );
}
