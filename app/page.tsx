import LocalForecastExperience from "@/components/local/LocalForecastExperience";

/**
 * The forecast is the site, so it is served at the root. It lived at `/sky`
 * while this was a cinematic Seoul sky scene; that scene is retired and the
 * name outlived the thing it named.
 *
 * No page-level `metadata` export: the root layout already declares the same
 * title and description, and a second copy here could only drift from it.
 */
export default function HomePage() {
  return (
    <>
      <LocalForecastExperience />

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
            background: "#0b0f14",
            color: "#e6edf3",
            fontFamily: "var(--font-geist-sans), system-ui, sans-serif",
          }}
        >
          <p style={{ fontSize: "0.7rem", letterSpacing: "0.24em", color: "#8a97a6" }}>
            오늘비 · KOREA
          </p>
          <h1 style={{ fontSize: "clamp(1.8rem, 6vw, 3rem)", fontWeight: 300, margin: 0 }}>
            비, 여기서는 어떨까요?
          </h1>
          <p style={{ maxWidth: "40ch", lineHeight: 1.7, color: "#b7c2ce", margin: 0 }}>
            내 위치의 오늘·내일 강수 예보와 날씨 서비스별 최근 지역 관측 성능을 비교합니다.
          </p>
          <p style={{ fontSize: "0.85rem", letterSpacing: "0.18em", color: "#8a97a6", margin: 0 }}>
            대한민국 전역 · 오늘과 내일 강수 · 최근 관측 성능
          </p>
          <p style={{ maxWidth: "44ch", fontSize: "0.8rem", lineHeight: 1.7, color: "#5e6c7b", margin: 0 }}>
            위치 선택과 라이브 예보를 보려면 JavaScript를 켜 주세요. 예보: Open-Meteo ·
            MET Norway · 기상청 외. 관측 검증: 기상청 ASOS.
          </p>
        </div>
      </noscript>
    </>
  );
}
