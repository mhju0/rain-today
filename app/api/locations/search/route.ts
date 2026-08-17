import { NextResponse } from "next/server";
import { LocationSearchNotConfiguredError, searchKoreanLocations } from "@/lib/locationSearch";
import { enforceRequestRateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const limited = enforceRequestRateLimit(request, "location-search", {
    limit: 20,
    windowMs: 60_000,
  });
  if (limited) return limited;
  try {
    const query = new URL(request.url).searchParams.get("q") ?? "";
    return NextResponse.json(
      { results: await searchKoreanLocations(query) },
      { headers: { "Cache-Control": "public, max-age=300" } },
    );
  } catch (error) {
    if (error instanceof RangeError) {
      return NextResponse.json({ error: "invalid_query" }, { status: 400 });
    }
    // A missing credential is permanent for this deployment. Reporting it as a
    // generic outage invited the client to offer a retry that always fails.
    if (error instanceof LocationSearchNotConfiguredError) {
      return NextResponse.json({ error: "search_not_configured" }, { status: 503 });
    }
    return NextResponse.json({ error: "location_search_unavailable" }, { status: 503 });
  }
}
