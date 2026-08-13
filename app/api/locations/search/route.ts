import { NextResponse } from "next/server";
import { searchKoreanLocations } from "@/lib/locationSearch";
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
    return NextResponse.json({ error: "location_search_unavailable" }, { status: 503 });
  }
}
