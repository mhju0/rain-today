export type ForecastLocationSelection =
  | { kind: "device"; accuracyM: number | null }
  | { kind: "administrative-area" };

export function formatHorizontalAccuracy(accuracyM: number | null): string {
  if (accuracyM === null || !Number.isFinite(accuracyM) || accuracyM < 0) {
    return "정확도 정보 없음";
  }
  if (accuracyM < 100) {
    return `약 ${Math.max(10, Math.round(accuracyM / 10) * 10)} m`;
  }
  if (accuracyM < 1_000) {
    return `약 ${Math.round(accuracyM / 100) * 100} m`;
  }
  return `약 ${(accuracyM / 1_000).toFixed(1)} km`;
}

export function describeForecastLocationSelection(
  selection: ForecastLocationSelection,
): { source: string; precision: string } {
  if (selection.kind === "device") {
    return {
      source: "현재 기기 위치",
      precision: formatHorizontalAccuracy(selection.accuracyM),
    };
  }
  return { source: "검색한 행정구역", precision: "행정구역 대표 위치" };
}
