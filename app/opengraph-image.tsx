import { ImageResponse } from "next/og";

export const alt = "오늘비 (raintoday) — Korea local rain forecast";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Latin only on purpose: `next/og` renders with a bundled Latin face, and any
 * Hangul here would come out as tofu unless a Korean font were embedded in the
 * build. The page itself stays Korean.
 */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: "linear-gradient(140deg, #0b1c24 0%, #071018 55%, #0a1418 100%)",
          color: "#f3f0e8",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: 6 }}>RAIN TODAY</div>
          <div style={{ fontSize: 20, color: "#9ba9b1", letterSpacing: 3 }}>KST · LIVE SOURCES</div>
        </div>

        <div style={{ display: "flex", alignItems: "flex-end", gap: 28 }}>
          <div style={{ fontSize: 210, fontWeight: 200, lineHeight: 1, color: "#edf5ef" }}>35</div>
          <div style={{ fontSize: 56, color: "#9ed9d2", paddingBottom: 34 }}>%</div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              paddingBottom: 30,
              paddingLeft: 24,
              gap: 8,
            }}
          >
            <div style={{ fontSize: 24, color: "#9ba9b1", letterSpacing: 3 }}>
              KOREA · LOCAL RAIN FORECAST
            </div>
            <div style={{ fontSize: 34, color: "#f3f0e8" }}>
              Today and tomorrow, where you actually are
            </div>
          </div>
        </div>

        <div style={{ display: "flex", fontSize: 22, color: "#7f8f96", letterSpacing: 1 }}>
          Open-Meteo · MET Norway · KMA · Pirate Weather · WeatherAPI
        </div>
      </div>
    ),
    size,
  );
}
