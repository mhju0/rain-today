import { NextResponse } from "next/server";
import { readLocalForecast } from "@/lib/localForecast";
import { parseLocalForecastRequest } from "@/lib/localForecastRequest";
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
    return NextResponse.json(toLocalForecastView(await readLocalForecast(input)), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json({ error: "forecast_unavailable" }, { status: 503 });
  }
}
