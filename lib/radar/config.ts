/**
 * Tunable knobs for the precipitation-radar section. The one place to adjust the
 * radar look — keep magic numbers here, not in the component.
 *
 * Source: high-resolution KMA reflectivity (apihub.kma.go.kr `nph-rdr_cmp1_api`, HSR
 * @ ~500 m), cropped to the Seoul metro, reprojected to Web Mercator and rendered
 * server-side to a transparent echo PNG (see lib/radar/{grid,geo,apihub}.ts). The echo
 * is overlaid on a keyless CARTO dark basemap, georeferenced by the crop's lat/lon
 * bounds. Attribution: KMA (radar) + © CARTO · © OpenStreetMap (basemap).
 */

export const RADAR_CONFIG = {
  /** Timeline auto-play frame interval (ms). */
  playIntervalMs: 700,
} as const;

/**
 * Keyless CARTO raster basemap. We use the **label-free** dark-matter variant
 * (`dark_nolabels`): CARTO's labelled rasters romanise Korean place names (서울 → "Seoul",
 * 남양주 → "Namyangju"), which reads wrong against this Korean-language product, so we
 * carry our own Korean labels (see CITY_LABELS) over the clean dark base — no double labels.
 */
export const BASEMAP = {
  /** {s}=subdomain, {z}/{x}/{y}=tile, {r}=@2x for retina crispness. */
  urlTemplate: "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png",
  subdomains: ["a", "b", "c", "d"],
  /** Fixed zoom for the Seoul-metro scope (~76 km across ≈ a ~600 px square). */
  zoom: 10,
  attribution: "© CARTO · © OpenStreetMap",
} as const;

/**
 * Korean place labels for the Seoul-metro window (lat 37.20–37.86, lon 126.50–127.36),
 * positioned by lat/lon via the same Web Mercator math as the echo. Kept deliberately
 * sparse so they orient without crowding the precipitation.
 */
export const CITY_LABELS: { ko: string; lat: number; lon: number }[] = [
  { ko: "서울", lat: 37.5665, lon: 126.978 },
  { ko: "인천", lat: 37.4563, lon: 126.7052 },
  { ko: "부천", lat: 37.5035, lon: 126.766 },
  { ko: "고양", lat: 37.6584, lon: 126.832 },
  { ko: "의정부", lat: 37.738, lon: 127.0337 },
  { ko: "남양주", lat: 37.636, lon: 127.2165 },
  { ko: "성남", lat: 37.42, lon: 127.1267 },
  { ko: "수원", lat: 37.2636, lon: 127.0286 },
];

/**
 * Legend stops, light → heavy, matching the server dBZ→RGBA ramp (deep indigo → cyan →
 * white). The 약함/보통/강함 labels carry the meaning; the colours mirror the echo so the
 * bar reads as a real key, not decoration.
 */
export const RADAR_LEGEND: { label: string; color: string }[] = [
  { label: "약함", color: "#3850b4" },
  { label: "", color: "#28a0d2" },
  { label: "보통", color: "#5adce6" },
  { label: "강함", color: "#f5ffff" },
];
