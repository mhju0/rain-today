/** One validated forecast target inside the South Korea launch area. */
export interface ForecastLocation {
  name: string;
  latitude: number;
  longitude: number;
  countryCode: "KR";
  timezone: "Asia/Seoul";
  kmaGrid: { nx: number; ny: number };
}

export interface ForecastLocationInput {
  name: string;
  latitude: number;
  longitude: number;
}

const KOREA_BOUNDS = {
  south: 32.75,
  north: 38.65,
  west: 124.5,
  east: 132,
} as const;

const KMA_GRID = {
  earthRadiusKm: 6371.00877,
  spacingKm: 5,
  standardParallel1: 30,
  standardParallel2: 60,
  originLongitude: 126,
  originLatitude: 38,
  originX: 43,
  originY: 136,
} as const;

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Convert WGS84 coordinates to the KMA 5 km Lambert forecast grid. */
export function locationToKmaGrid(latitude: number, longitude: number): { nx: number; ny: number } {
  const re = KMA_GRID.earthRadiusKm / KMA_GRID.spacingKm;
  const slat1 = radians(KMA_GRID.standardParallel1);
  const slat2 = radians(KMA_GRID.standardParallel2);
  const olon = radians(KMA_GRID.originLongitude);
  const olat = radians(KMA_GRID.originLatitude);

  const sn =
    Math.log(Math.cos(slat1) / Math.cos(slat2)) /
    Math.log(Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5));
  const sf =
    (Math.cos(slat1) * Math.pow(Math.tan(Math.PI * 0.25 + slat1 * 0.5), sn)) / sn;
  const ro = (re * sf) / Math.pow(Math.tan(Math.PI * 0.25 + olat * 0.5), sn);
  const ra = (re * sf) / Math.pow(Math.tan(Math.PI * 0.25 + radians(latitude) * 0.5), sn);

  let theta = radians(longitude) - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;

  return {
    nx: Math.floor(ra * Math.sin(theta) + KMA_GRID.originX + 0.5),
    ny: Math.floor(ro - ra * Math.cos(theta) + KMA_GRID.originY + 0.5),
  };
}

/** Validate and normalize one coordinate target for the South Korea launch. */
export function createForecastLocation(input: ForecastLocationInput): ForecastLocation {
  if (!Number.isFinite(input.latitude) || !Number.isFinite(input.longitude)) {
    throw new TypeError("location coordinates must be finite");
  }
  if (
    input.latitude < KOREA_BOUNDS.south ||
    input.latitude > KOREA_BOUNDS.north ||
    input.longitude < KOREA_BOUNDS.west ||
    input.longitude > KOREA_BOUNDS.east
  ) {
    throw new RangeError("location must be within the South Korea service area");
  }

  return {
    name: input.name.trim() || "현재 위치",
    latitude: input.latitude,
    longitude: input.longitude,
    countryCode: "KR",
    timezone: "Asia/Seoul",
    kmaGrid: locationToKmaGrid(input.latitude, input.longitude),
  };
}

/** Stable location identity for provider caches; four decimals retain street-scale separation. */
export function forecastLocationCacheKey(location: ForecastLocation): string {
  return `kr:${location.latitude.toFixed(4)}:${location.longitude.toFixed(4)}`;
}

export const DEFAULT_FORECAST_LOCATION = createForecastLocation({
  name: "서울",
  latitude: 37.5665,
  longitude: 126.978,
});
