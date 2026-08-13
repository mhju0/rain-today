import type { Metadata } from "next";
import LocalForecastExperience from "@/components/local/LocalForecastExperience";

export const metadata: Metadata = {
  title: "SeoulSky — 최근 지역 성능을 반영한 전국 강수 예보",
  description: "내 위치의 내일 강수 예보와 각 날씨 서비스의 최근 지역별 관측 성능을 비교하세요.",
};

export default function SkyPage() {
  return <LocalForecastExperience />;
}
