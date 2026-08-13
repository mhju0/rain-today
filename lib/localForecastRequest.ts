import { createKoreanLocation, type KoreanLocation } from "./location.ts";

export interface ParsedLocalForecastRequest {
  location: KoreanLocation;
  elevationM: number | null;
}

export function parseLocalForecastRequest(request: Request): ParsedLocalForecastRequest {
  const params = new URL(request.url).searchParams;
  const latitude = Number(params.get("lat"));
  const longitude = Number(params.get("lon"));
  const name = (params.get("name") ?? "현재 위치").normalize("NFKC").trim();
  if (name.length > 80) throw new RangeError("location name is too long");
  const elevationValue = params.get("elevation");
  const elevationM = elevationValue === null || elevationValue === "" ? null : Number(elevationValue);
  if (elevationM !== null && (!Number.isFinite(elevationM) || elevationM < -20 || elevationM > 3000)) {
    throw new RangeError("elevation must be a finite Korean terrain height");
  }
  return {
    location: createKoreanLocation({ name, latitude, longitude }),
    elevationM,
  };
}
