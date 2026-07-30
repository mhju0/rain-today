import { NextResponse } from "next/server";
import { getRadarSummary } from "@/lib/providers/radar";
import { enforceRequestRateLimit } from "@/lib/rateLimit";

/**
 * GET /api/weather/radar — RainViewer radar metadata + the conservative
 * approach analysis, for /diagnostics. Optional; returns { available:false }
 * (never an error) when radar can't be reached. Attribution is included so any
 * visible radar layer can credit RainViewer.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const limited = enforceRequestRateLimit(request, "weather-radar", { limit: 30, windowMs: 60_000 });
  if (limited) return limited;
  const summary = await getRadarSummary();
  if (!summary) {
    return NextResponse.json(
      { available: false, frames: [], attribution: "RainViewer" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(summary, { headers: { "Cache-Control": "no-store" } });
}
