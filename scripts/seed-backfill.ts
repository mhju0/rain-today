/**
 * One-shot retrospective seed backfill.
 *
 *     npm run performance:seed -- --start=2025-06-01 --end=2025-08-31
 *     npm run performance:seed -- --start=2025-06-01 --end=2025-08-31 --station=108
 *
 * Rebuilds day-ahead forecast evidence from public archives and stores it as Seed
 * Comparisons, so a station answers with real weights before any live capture has
 * accrued. Offline and idempotent: re-running stores only what is missing.
 *
 * Stations come from KMA apihub when the `stn_inf` subscription is available, and
 * from the committed fallback catalog otherwise.
 */
import { mergeStationCatalog, runSeedBackfill } from "../lib/performance/backfill.ts";
import { fetchKmaAsosStations } from "../lib/performance/kma.ts";
import { PostgresPerformanceStore } from "../lib/performance/postgres.ts";
import {
  FALLBACK_STATION_CATALOG,
  isPlaceholderCatalog,
} from "../lib/performance/stationCatalog.ts";
import type { ObservationStation } from "../lib/performance/types.ts";

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const startDate = option("start");
const endDate = option("end");
if (!startDate || !endDate) {
  console.error("usage: performance:seed -- --start=YYYY-MM-DD --end=YYYY-MM-DD [--station=108]");
  process.exit(1);
}

const connectionUrl = process.env.PERFORMANCE_DATABASE_URL?.trim();
if (!connectionUrl) {
  console.error("PERFORMANCE_DATABASE_URL is required");
  process.exit(1);
}

let catalogIsAuthoritative = true;

async function resolveStations(): Promise<ObservationStation[]> {
  try {
    const stations = await fetchKmaAsosStations(new Date());
    console.log(`station catalog: ${stations.length} stations from apihub`);
    return stations;
  } catch (error) {
    catalogIsAuthoritative = false;
    const reason = error instanceof Error ? error.message : "unknown error";
    console.warn(`apihub station catalog unavailable (${reason}); using the committed fallback`);
    if (isPlaceholderCatalog()) {
      console.warn(
        "the committed catalog is still a placeholder — run `npm run performance:catalog` " +
          "once the apihub stn_inf subscription is active to backfill nationwide",
      );
    }
    return [...FALLBACK_STATION_CATALOG];
  }
}

const requested = option("station");
const allStations = await resolveStations();
const stations = requested
  ? allStations.filter((station) => station.id === requested)
  : allStations;
if (stations.length === 0) {
  console.error(`no station matched --station=${requested}`);
  process.exit(1);
}

const store = new PostgresPerformanceStore(connectionUrl);
try {
  await store.initialize();
  // Seed rows reference performance_stations, so the catalog must exist first.
  // Only the apihub catalog is authoritative about which stations are ACTIVE; a
  // fallback list is merged in so it cannot retire what the live pipeline knows.
  // Sync the WHOLE catalog either way: --station narrows what gets backfilled, and
  // syncing that subset would declare every other station retired.
  const catalog = catalogIsAuthoritative
    ? allStations
    : mergeStationCatalog(await store.listStations(), allStations);
  await store.syncStations(catalog, new Date().toISOString().slice(0, 10));

  const result = await runSeedBackfill({
    stations,
    startDate,
    endDate,
    now: new Date(),
    store,
    onProgress: (stationId, stored) => console.log(`  ${stationId}: +${stored}`),
  });

  console.log(
    `\n${result.stationCount} stations x ${result.windowCount} windows: ` +
      `${result.comparisonsBuilt} built, ${result.comparisonsStored} newly stored`,
  );
  for (const failure of result.failures) {
    console.warn(`  failed ${failure.stationId} ${failure.window}: ${failure.message}`);
  }
  if (result.failures.length > 0) {
    console.warn(`${result.failures.length} window(s) failed; re-run to retry only those`);
  }
} finally {
  await store.close();
}
