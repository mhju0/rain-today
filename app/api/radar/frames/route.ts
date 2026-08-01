import { NextResponse } from "next/server.js";
import { type RadarDelivery, productionRadarDelivery } from "../../../../lib/radar/delivery.ts";
import { enforceRequestRateLimit } from "../../../../lib/rateLimit.ts";

/**
 * GET /api/radar/frames — the KMA radar composite timeline: the recent observed
 * frames (oldest → newest, 5-min cadence) the scrubber plays through. RadarDelivery
 * owns the probe and source access; this route never exposes the service key. Returns
 * { available:false, frames:[] } (not an error) when the source is unavailable.
 */
export const dynamic = "force-dynamic";
// productionRadarDelivery.timeline() renders/probes only the newest permitted frame to
// establish readiness, then returns the timeline; it does not warm or promise cache hits
// for later frames. The route's 60-second configured maximum does not change the KMA
// frame fetch timeout in apihub.ts.
export const maxDuration = 60;

export async function deliverRadarTimeline(
  request: Request,
  delivery: Pick<RadarDelivery, "timeline">,
) {
  const limited = enforceRequestRateLimit(request, "radar-frames", { limit: 30, windowMs: 60_000 });
  if (limited) return limited;
  const data = await delivery.timeline(request.signal);
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  return deliverRadarTimeline(request, productionRadarDelivery);
}
