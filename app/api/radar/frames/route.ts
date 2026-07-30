import { NextResponse } from "next/server";
import { recentRadarFrames } from "@/lib/radar/kma";
import { enforceRequestRateLimit } from "@/lib/rateLimit";

/**
 * GET /api/radar/frames — the KMA radar composite timeline: the recent observed
 * frames (oldest → newest, 5-min cadence) the scrubber plays through. Pure time
 * math + a single cached probe; never exposes the service key. Returns
 * { available:false, frames:[] } (not an error) when the source is unavailable.
 */
export const dynamic = "force-dynamic";
// recentRadarFrames() warms the newest frame on cold start: one echo-grid fetch
// (AbortSignal.timeout 25s in apihub.ts) + boot + reproject/encode. Raise the function
// ceiling to Hobby's max (60s) so that work isn't killed by the low default. This widens
// the budget; it cannot make a >60s upstream succeed.
export const maxDuration = 60;

export async function GET(request: Request) {
  const limited = enforceRequestRateLimit(request, "radar-frames", { limit: 30, windowMs: 60_000 });
  if (limited) return limited;
  const data = await recentRadarFrames();
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
