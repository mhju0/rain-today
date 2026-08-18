/**
 * Regenerate lib/performance/stationCatalog.ts from the official KMA apihub
 * surface-station catalog. Offline utility: never imported by the web runtime.
 *
 *     KMA_APIHUB_KEY=... npm run performance:catalog
 *
 * Requires the apihub `stn_inf` subscription (지점정보). Without it the request
 * returns 403 and this script exits non-zero rather than writing a partial file.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fetchKmaAsosStations } from "../lib/performance/kma.ts";
import type { ObservationStation } from "../lib/performance/types.ts";

const TARGET = path.join(process.cwd(), "lib", "performance", "stationCatalog.ts");

function render(stations: readonly ObservationStation[], generatedAt: string): string {
  const rows = stations
    .map((station) => `  {
    id: ${JSON.stringify(station.id)},
    name: ${JSON.stringify(station.name)},
    network: "ASOS",
    latitude: ${station.latitude},
    longitude: ${station.longitude},
    elevationM: ${station.elevationM},
    activeFrom: ${JSON.stringify(station.activeFrom)},
    activeTo: null,
  },`)
    .join("\n");

  return `import type { ObservationStation } from "./types.ts";

/**
 * Committed fallback ASOS station catalog.
 *
 * The live pipeline reads the catalog from KMA apihub \`stn_inf\`. This file is the
 * fallback for the OFFLINE seed backfill, which must be able to run without that
 * subscription. It is GENERATED, never hand-edited:
 *
 *     npm run performance:catalog        # requires KMA_APIHUB_KEY with stn_inf access
 *
 * Generated ${generatedAt} from ${stations.length} official stations.
 */

export const FALLBACK_STATION_CATALOG: readonly ObservationStation[] = [
${rows}
];

/** True while the catalog has not yet been regenerated from the official source. */
export function isPlaceholderCatalog(
  catalog: readonly ObservationStation[] = FALLBACK_STATION_CATALOG,
): boolean {
  return catalog.length <= 1;
}
`;
}

const stations = await fetchKmaAsosStations(new Date());
if (stations.length < 20) {
  console.error(`refusing to write a catalog of only ${stations.length} stations`);
  process.exit(1);
}
writeFileSync(TARGET, render(stations, new Date().toISOString().slice(0, 10)), "utf8");
console.log(`wrote ${stations.length} stations to lib/performance/stationCatalog.ts`);
