import { createKoreanLocation, type KoreanLocation } from "./location.ts";

export interface ParsedLocalForecastRequest {
  location: KoreanLocation;
  elevationM: number | null;
}

interface LocalForecastBody {
  name?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  elevationM?: unknown;
}

export async function parseLocalForecastRequest(
  request: Request,
): Promise<ParsedLocalForecastRequest> {
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
    throw new TypeError("local forecast body must be JSON");
  }
  const raw = await request.json() as LocalForecastBody;
  const latitude = typeof raw.latitude === "number" ? raw.latitude : Number.NaN;
  const longitude = typeof raw.longitude === "number" ? raw.longitude : Number.NaN;
  const name = typeof raw.name === "string" ? raw.name.normalize("NFKC").trim() : "현재 위치";
  if (name.length > 80) throw new RangeError("location name is too long");
  const elevationM = raw.elevationM === null || raw.elevationM === undefined
    ? null
    : typeof raw.elevationM === "number"
      ? raw.elevationM
      : Number.NaN;
  if (elevationM !== null && (!Number.isFinite(elevationM) || elevationM < -20 || elevationM > 3000)) {
    throw new RangeError("elevation must be a finite Korean terrain height");
  }
  return {
    location: createKoreanLocation({ name, latitude, longitude }),
    elevationM,
  };
}
