import type { ReactNode } from "react";

export default function SkyLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}

      <noscript>
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "1.25rem",
            padding: "2rem",
            textAlign: "center",
            background: "#04060d",
            color: "#e2e8f0",
            fontFamily: "var(--font-geist-sans), system-ui, sans-serif",
          }}
        >
          <p style={{ fontSize: "0.7rem", letterSpacing: "0.24em", color: "#94a3b8" }}>
            오늘비 · KOREA
          </p>
          <h1 style={{ fontSize: "clamp(1.8rem, 6vw, 3rem)", fontWeight: 300, margin: 0 }}>
            비, 여기서는 어떨까요?
          </h1>
          <p style={{ maxWidth: "40ch", lineHeight: 1.7, color: "#cbd5e1", margin: 0 }}>
            내 위치의 오늘·내일 강수 예보와 날씨 서비스별 최근 지역 관측 성능을 비교합니다.
          </p>
          <p style={{ fontSize: "0.85rem", letterSpacing: "0.18em", color: "#94a3b8", margin: 0 }}>
            대한민국 전역 · 오늘과 내일 강수 · 최근 관측 성능
          </p>
          <p style={{ maxWidth: "44ch", fontSize: "0.8rem", lineHeight: 1.7, color: "#7c8aa0", margin: 0 }}>
            위치 선택과 라이브 예보를 보려면 JavaScript를 켜 주세요. 예보: Open-Meteo ·
            MET Norway · 기상청 외. 관측 검증: 기상청 ASOS.
          </p>
        </div>
      </noscript>
    </>
  );
}
