import { createKoreanLocation, type KoreanLocation } from "./location.ts";

const MAX_LOCAL_FORECAST_BODY_BYTES = 4 * 1024;

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

async function readBoundedJson(request: Request): Promise<LocalForecastBody> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_LOCAL_FORECAST_BODY_BYTES) {
      throw new RangeError("local forecast body too large");
    }
  }
  if (!request.body) throw new TypeError("local forecast body is required");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_LOCAL_FORECAST_BODY_BYTES) {
        await reader.cancel("local forecast body too large");
        throw new RangeError("local forecast body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as LocalForecastBody;
}

export async function parseLocalForecastRequest(
  request: Request,
): Promise<ParsedLocalForecastRequest> {
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
    throw new TypeError("local forecast body must be JSON");
  }
  const raw = await readBoundedJson(request);
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
