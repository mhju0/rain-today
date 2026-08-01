import type { RadarDelivery } from "./delivery.ts";

/** Testable HTTP mapping kept below the route so app adapters can use project aliases. */
export async function deliverRadarFrame(
  request: Request,
  delivery: Pick<RadarDelivery, "frame">,
): Promise<Response> {
  const key = new URL(request.url).searchParams.get("t") ?? "";
  const result = await delivery.frame(key, request.signal);

  switch (result.kind) {
    case "ready":
      return new Response(new Uint8Array(result.png), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
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
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": String(result.retryAfterSeconds),
        },
      });
    case "cancelled":
      return new Response("request cancelled", {
        status: 499,
        headers: { "Cache-Control": "no-store" },
      });
    case "unavailable":
      return new Response("radar unavailable", {
        status: 502,
        headers: { "Cache-Control": "no-store" },
      });
  }
}

/** Timeline success stays JSON/no-store; unavailability is represented in the body. */
export async function deliverRadarTimeline(
  request: Request,
  delivery: Pick<RadarDelivery, "timeline">,
): Promise<Response> {
  const data = await delivery.timeline(request.signal);
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
