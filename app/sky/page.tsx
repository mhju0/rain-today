import type { Metadata } from "next";
import LocalForecastExperience from "@/components/local/LocalForecastExperience";

export const metadata: Metadata = {
  title: "오늘비 — 내 위치의 오늘·내일 비 예보",
  description: "내 위치의 오늘·내일 비 예보를 날씨 서비스별로 비교하고, 가까운 관측소의 최근 관측 성능을 반영합니다.",
};

export default function SkyPage() {
  return <LocalForecastExperience />;
}
