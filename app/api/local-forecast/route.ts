import { NextResponse } from "next/server";
import { readLocalForecast } from "@/lib/localForecast";
import { parseLocalForecastRequest } from "@/lib/localForecastRequest";
import { DEVICE_LOCATION_PLACEHOLDER } from "@/lib/location";
import { describeKoreanCoordinate } from "@/lib/locationSearch";
import { toLocalForecastView } from "@/lib/localForecastView";
import { enforceRequestRateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const limited = enforceRequestRateLimit(request, "local-forecast", {
    limit: 30,
    windowMs: 60_000,
  });
  if (limited) return limited;
  let input: Awaited<ReturnType<typeof parseLocalForecastRequest>>;
  try {
    // Only a rejected request body is an invalid location. Reading the forecast
    // can throw a TypeError from far inside a provider or the store, and
    // reporting that as a 400 would blame the user for a server fault.
    input = await parseLocalForecastRequest(request);
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) {
      return NextResponse.json({ error: "invalid_location" }, { status: 400 });
    }
    return NextResponse.json({ error: "forecast_unavailable" }, { status: 503 });
  }
  try {
    // A device fix arrives unnamed. Resolving it here — rather than trusting a
    // client-supplied label — keeps the name derived from the same coordinate
    // the forecast is read for. Enrichment only: a null keeps the placeholder.
    const resolved = input.location.name === DEVICE_LOCATION_PLACEHOLDER
      ? await describeKoreanCoordinate(input.location.latitude, input.location.longitude)
      : null;
    const located = resolved
      ? { ...input, location: { ...input.location, name: resolved } }
      : input;
    return NextResponse.json(toLocalForecastView(await readLocalForecast(located)), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json({ error: "forecast_unavailable" }, { status: 503 });
  }
}
