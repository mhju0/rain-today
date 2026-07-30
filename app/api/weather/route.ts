import { NextResponse } from "next/server";
import { readProductionWeatherIntelligence } from "@/lib/weatherIntelligence.production";
import { enforceRequestRateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const limited = enforceRequestRateLimit(request, "weather", { limit: 20, windowMs: 60_000 });
  if (limited) return limited;
  return NextResponse.json(await readProductionWeatherIntelligence(), {
    headers: { "Cache-Control": "no-store" },
  });
}
