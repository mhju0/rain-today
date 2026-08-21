"use client";

/**
 * PROTOTYPE — throwaway. Do not merge to main.
 *
 * Three variants of the evidence block at the end of the dashboard, switchable
 * with `?variant=A|B|C` on the existing route, plus `?mode=seed|learned` to see
 * either evidence state. Answers #67, feeding the decision in #70.
 *
 * The question is volume, not placement: the apparatus is already one block at
 * the bottom, and a trust line already renders in the main read. What is open is
 * how much of it appears unprompted.
 *
 *   A  Baseline      exactly what ships today
 *   B  One affordance the whole block behind a single opener
 *   C  Verdict only   card layer removed, table behind the existing disclosure
 *
 * No tests, no error handling, no abstractions. Prototype constraints.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { LocalForecastView } from "@/lib/localForecastView";

export const PROTOTYPE_VARIANTS = ["A", "B", "C"] as const;
export type PrototypeVariant = (typeof PROTOTYPE_VARIANTS)[number];
export type PrototypeMode = "seed" | "learned";

const VARIANT_NAMES: Record<PrototypeVariant, string> = {
  A: "baseline",
  B: "opener",
  C: "verdict",
};

const ENABLED = process.env.NODE_ENV !== "production";

/** Inlined so the prototype never depends on where the app allows CSS imports. */
const PROTOTYPE_CSS = `
/* PROTOTYPE — throwaway. Do not merge to main. Loaded only by the prototype branch. */

.proto-disclosure {
  border-top: 1px solid var(--local-rule, rgba(255, 255, 255, 0.12));
  padding-top: 1.25rem;
  margin-top: 1.5rem;
}
.proto-disclosure > summary {
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 1rem;
  font-weight: 500;
  padding: 0.5rem 0;
}
.proto-disclosure > summary > span {
  font-family: var(--font-geist-mono), ui-monospace, monospace;
  font-size: 0.7rem;
  letter-spacing: 0.12em;
  opacity: 0.55;
}

.proto-verdict {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  border-top: 1px solid var(--local-rule, rgba(255, 255, 255, 0.12));
  padding-top: 1.25rem;
  margin-top: 1.5rem;
}
.proto-verdict > b {
  font-size: 0.95rem;
}
.proto-verdict > span {
  font-family: var(--font-geist-mono), ui-monospace, monospace;
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  opacity: 0.62;
  line-height: 1.6;
}

/* Deliberately not in the page's visual language — this must not read as design. */
.proto-bar {
  position: fixed;
  bottom: 1rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 200;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.6rem;
  border-radius: 999px;
  background: #fff;
  color: #111;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  font-family: ui-monospace, monospace;
  font-size: 0.7rem;
  white-space: nowrap;
  max-width: calc(100vw - 1.5rem);
}
.proto-bar > * {
  flex: 0 0 auto;
}
.proto-bar button {
  border: 0;
  background: #ececec;
  color: #111;
  border-radius: 999px;
  padding: 0.22rem 0.6rem;
  cursor: pointer;
  font: inherit;
}
.proto-bar button.is-on {
  background: #111;
  color: #fff;
}
.proto-bar-label b {
  margin-right: 0.35rem;
}
.proto-bar-sep {
  width: 1px;
  height: 1rem;
  background: #d5d5d5;
}
`;

export interface PrototypeState {
  variant: PrototypeVariant;
  mode: PrototypeMode;
}

/**
 * The URL is the source of truth. `useSyncExternalStore` keeps the server
 * snapshot empty, so hydration agrees without a setState-in-effect.
 */
const urlListeners = new Set<() => void>();

function subscribeUrl(onChange: () => void): () => void {
  urlListeners.add(onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    urlListeners.delete(onChange);
    window.removeEventListener("popstate", onChange);
  };
}

function parseSearch(search: string): PrototypeState | null {
  if (!ENABLED) return null;
  const query = new URLSearchParams(search);
  const raw = (query.get("variant") ?? "").toUpperCase();
  if (!PROTOTYPE_VARIANTS.includes(raw as PrototypeVariant)) return null;
  return {
    variant: raw as PrototypeVariant,
    mode: query.get("mode") === "learned" ? "learned" : "seed",
  };
}

export function usePrototypeState(): [PrototypeState | null, (next: PrototypeState) => void] {
  const search = useSyncExternalStore(
    subscribeUrl,
    () => window.location.search,
    () => "",
  );
  const state = useMemo(() => parseSearch(search), [search]);

  const update = useCallback((next: PrototypeState) => {
    const query = new URLSearchParams(window.location.search);
    query.set("variant", next.variant);
    query.set("mode", next.mode);
    window.history.replaceState(null, "", `${window.location.pathname}?${query}`);
    urlListeners.forEach((listener) => listener());
  }, []);

  return [state, update];
}

/**
 * No station has real learned weights yet — the network crosses its 30-capture
 * gate around 2026-09-18 — so `learned` has to be faked to be seen at all.
 */
export function applyPrototypeMode(
  forecast: LocalForecastView,
  mode: PrototypeMode | null,
): LocalForecastView {
  if (mode !== "learned") return forecast;

  const scores = forecast.influence.map((provider, index) => ({
    id: provider.id,
    name: provider.name,
    last7DaysBrier: 0.104 + index * 0.021,
    windowBrier: 0.118 + index * 0.019,
    windowSampleCount: 34,
    misses: 1 + index,
    falseAlarms: 2 + index,
    rainyAmountMae: 1.4 + index * 0.6,
    rainyAmountSampleCount: 11,
  }));

  return {
    ...forecast,
    blendMode: "learned",
    evidence: {
      ...forecast.evidence,
      status: "active",
      statusLabel: "가중치 반영 중",
      comparisonSampleCount: 34,
      emptyMessage: null,
      emptyDetail: null,
      scores,
      seedScores: [],
      benchmark: { adaptiveBrier: 0.118, equalBrier: 0.131 },
    },
  };
}

/** One compact line standing in for the whole card layer, in variant C. */
function VerdictLine({ forecast }: { forecast: LocalForecastView }) {
  const { station, comparisonSampleCount, benchmark } = forecast.evidence;
  const seeded = forecast.blendMode === "seed";
  return (
    <p className="proto-verdict">
      <b>{forecast.evidence.statusLabel}</b>
      <span>
        {station ? `${station.name} · ${station.distanceKm.toFixed(1)}km` : "관측소 미연결"}
        {" · "}
        {seeded
          ? "과거 예보 기록으로 추정 · 영향 일부만 반영"
          : `최근 ${comparisonSampleCount}일 기록 반영`}
        {benchmark?.adaptiveBrier !== null && benchmark?.equalBrier != null
          ? ` · 벤치마크 ${benchmark.adaptiveBrier?.toFixed(3)} vs ${benchmark.equalBrier.toFixed(3)}`
          : ""}
      </span>
    </p>
  );
}

export function PrototypeEvidence({
  variant,
  forecast,
  table,
  children,
}: {
  variant: PrototypeVariant;
  forecast: LocalForecastView;
  /** The scored provider table, so variant C can keep it without the cards. */
  table: ReactNode;
  /** The three evidence cards, unchanged from the real page. */
  children: ReactNode;
}) {
  if (variant === "B") {
    return (
      <details className="proto-disclosure">
        <summary>
          이 예보를 왜 믿어도 될까요?
          <span>관측소 대조 · 서비스별 최근 성능 · 채점 원자료</span>
        </summary>
        {children}
        {table}
      </details>
    );
  }

  if (variant === "C") {
    return (
      <>
        <VerdictLine forecast={forecast} />
        <details className="proto-disclosure">
          <summary>
            서비스별 채점 기록 보기
            <span>어떤 서비스가 이 지역에서 더 잘 맞았는지</span>
          </summary>
          {table}
        </details>
      </>
    );
  }

  return (
    <>
      {children}
      {table}
    </>
  );
}

export function PrototypeSwitcher({
  state,
  onChange,
}: {
  state: PrototypeState;
  onChange(next: PrototypeState): void;
}) {
  const cycle = useCallback(
    (step: number) => {
      const index = PROTOTYPE_VARIANTS.indexOf(state.variant);
      const next = PROTOTYPE_VARIANTS[
        (index + step + PROTOTYPE_VARIANTS.length) % PROTOTYPE_VARIANTS.length
      ];
      onChange({ ...state, variant: next });
    },
    [state, onChange],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      if (event.key === "ArrowLeft") cycle(-1);
      if (event.key === "ArrowRight") cycle(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycle]);

  if (!ENABLED) return null;

  return (
    <>
    <style>{PROTOTYPE_CSS}</style>
    <div className="proto-bar">
      <button type="button" onClick={() => cycle(-1)} aria-label="이전 변형">←</button>
      <span className="proto-bar-label">
        <b>{state.variant}</b> {VARIANT_NAMES[state.variant]}
      </span>
      <button type="button" onClick={() => cycle(1)} aria-label="다음 변형">→</button>
      <span className="proto-bar-sep" />
      <button
        type="button"
        className={state.mode === "seed" ? "is-on" : ""}
        onClick={() => onChange({ ...state, mode: "seed" })}
      >
        seed
      </button>
      <button
        type="button"
        className={state.mode === "learned" ? "is-on" : ""}
        onClick={() => onChange({ ...state, mode: "learned" })}
      >
        learned
      </button>
    </div>
    </>
  );
}
