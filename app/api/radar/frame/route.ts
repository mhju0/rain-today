import { type RadarDelivery, productionRadarDelivery } from "../../../../lib/radar/delivery.ts";
import { enforceRequestRateLimit } from "../../../../lib/rateLimit.ts";

/**
 * GET /api/radar/frame?t=<yyyyMMddHHmm> — the server-rendered Seoul echo PNG for one
 * frame. The client only ever talks to this route; the apihub key and the ~13 MB raw
 * reflectivity grid NEVER reach the browser. RadarDelivery renders and caches the frame;
 * this route streams the small transparent PNG. A produced frame is immutable, so the
 * response is cached hard.
 */
export const dynamic = "force-dynamic";
// Cold start fetches the ~13 MB echo grid (AbortSignal.timeout 25s in apihub.ts) plus
// boot + reproject/encode. That can exceed Vercel's low default function ceiling, so raise
// it to Hobby's max (60s). This widens the budget; it can't make a >60s upstream succeed.
export const maxDuration = 60;

export async function deliverRadarFrame(
  req: Request,
  delivery: Pick<RadarDelivery, "frame">,
) {
  const limited = enforceRequestRateLimit(req, "radar-frame", { limit: 60, windowMs: 60_000 });
  if (limited) return limited;
  const t = new URL(req.url).searchParams.get("t") ?? "";
  const result = await delivery.frame(t, req.signal);
  switch (result.kind) {
    case "ready":
      // Copy into a fresh ArrayBuffer-backed view: a small (e.g. fully-transparent) frame's
      // Buffer can be pool-backed, and Buffer isn't a typed BodyInit.
      return new Response(new Uint8Array(result.png), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          // A produced frame never changes — let the browser/CDN keep it.
          "Cache-Control": "public, max-age=86400, s-maxage=86400, immutable",
        },
      });
    case "invalid":
      return new Response("bad request", {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      });
    case "busy":
      return new Response("radar busy", {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "1" },
      });
    case "cancelled":
      return new Response("request cancelled", {
        status: 499,
        headers: { "Cache-Control": "no-store" },
      });
    case "unavailable":
      // No key, source down, frame not published yet, or malformed grid — degrade quietly
      // (no key in any message).
      return new Response("radar unavailable", {
        status: 502,
        headers: { "Cache-Control": "no-store" },
      });
  }
}

export async function GET(request: Request) {
  return deliverRadarFrame(request, productionRadarDelivery);
}
