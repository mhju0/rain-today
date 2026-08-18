import type { ObservationStation } from "./types.ts";

/**
 * Committed fallback ASOS station catalog.
 *
 * The live pipeline reads the catalog from KMA apihub `stn_inf`. This file is the
 * fallback for the OFFLINE seed backfill, which must be able to run without that
 * subscription. It is GENERATED, never hand-edited:
 *
 *     npm run performance:catalog        # requires KMA_APIHUB_KEY with stn_inf access
 *
 * Coordinates here are official KMA values reproduced verbatim by that script.
 * Never add a station by hand — an invented coordinate would silently mis-assign
 * every observation for that station and there is no downstream check that
 * would catch it.
 */

export const FALLBACK_STATION_CATALOG: readonly ObservationStation[] = [
  // 서울 (종로구 송월동). Verified against the apihub catalog row committed in
  // kma.test.ts; the generator replaces this list wholesale.
  {
    id: "108",
    name: "서울",
    network: "ASOS",
    latitude: 37.5714,
    longitude: 126.9658,
    elevationM: 85.7,
    activeFrom: "2020-01-01",
    activeTo: null,
  },
];

/** True while the catalog has not yet been regenerated from the official source. */
export function isPlaceholderCatalog(
  catalog: readonly ObservationStation[] = FALLBACK_STATION_CATALOG,
): boolean {
  return catalog.length <= 1;
}
