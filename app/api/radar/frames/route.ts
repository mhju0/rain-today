import { productionRadarDelivery } from "@/lib/radar/delivery";
import { deliverRadarTimeline } from "@/lib/radar/http";
import { enforceRequestRateLimit } from "@/lib/rateLimit";

/**
 * GET /api/radar/frames — thirteen recent observed KMA frames, oldest to newest at
 * five-minute cadence. RadarDelivery owns newest-deliverable discovery and source access.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const limited = enforceRequestRateLimit(request, "radar-frames", {
    limit: 30,
    windowMs: 60_000,
  });
  if (limited) return limited;
  return deliverRadarTimeline(request, productionRadarDelivery);
}
