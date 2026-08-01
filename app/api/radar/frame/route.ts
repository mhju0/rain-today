import { productionRadarDelivery } from "@/lib/radar/delivery";
import { deliverRadarFrame } from "@/lib/radar/http";
import { enforceRequestRateLimit } from "@/lib/rateLimit";

/**
 * GET /api/radar/frame?t=<yyyyMMddHHmm> — the server-rendered Seoul echo PNG for one
 * frame. The client only ever talks to this route; the API Hub key and raw grid remain
 * server-side. RadarDelivery owns validation, rendering, admission, and immutable bytes.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const limited = enforceRequestRateLimit(request, "radar-frame", {
    limit: 60,
    windowMs: 60_000,
  });
  if (limited) return limited;
  return deliverRadarFrame(request, productionRadarDelivery);
}
