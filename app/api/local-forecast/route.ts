import { NextResponse } from "next/server";
import { readLocalForecast } from "@/lib/localForecast";
import { parseLocalForecastRequest } from "@/lib/localForecastRequest";
import { enforceRequestRateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const limited = enforceRequestRateLimit(request, "local-forecast", {
    limit: 30,
    windowMs: 60_000,
  });
  if (limited) return limited;
  try {
    const input = await parseLocalForecastRequest(request);
    return NextResponse.json(await readLocalForecast(input), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) {
      return NextResponse.json({ error: "invalid_location" }, { status: 400 });
    }
    return NextResponse.json({ error: "forecast_unavailable" }, { status: 503 });
  }
}
