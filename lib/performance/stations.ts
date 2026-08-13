import type { ObservationStation } from "./types.ts";

export interface StationSelectionPolicy {
  maxDistanceKm: number;
  maxElevationDifferenceM: number;
}

export interface StationSelection {
  status: "matched" | "unavailable";
  reason: "eligible-station" | "no-eligible-station";
  station: ObservationStation | null;
  distanceKm: number | null;
  elevationDifferenceM: number | null;
}

interface StationSelectionInput {
  location: { latitude: number; longitude: number; elevationM?: number | null };
  stations: readonly ObservationStation[];
  at: Date;
  policy: StationSelectionPolicy;
}

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

function distanceKm(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const earthRadiusKm = 6371.0088;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const lat1 = radians(a.latitude);
  const lat2 = radians(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(h));
}

function calendarDateInKorea(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Choose the nearest observation station that passes every representation gate. */
export function selectObservationStation(input: StationSelectionInput): StationSelection {
  const atDate = calendarDateInKorea(input.at);
  const eligible = input.stations.flatMap((station) => {
    if (station.activeFrom > atDate || (station.activeTo !== null && station.activeTo < atDate)) {
      return [];
    }
    const stationDistanceKm = distanceKm(input.location, station);
    const elevationDifferenceM =
      input.location.elevationM == null || station.elevationM == null
        ? null
        : Math.abs(input.location.elevationM - station.elevationM);
    if (stationDistanceKm > input.policy.maxDistanceKm) return [];
    if (
      elevationDifferenceM !== null &&
      elevationDifferenceM > input.policy.maxElevationDifferenceM
    ) {
      return [];
    }
    return [{ station, stationDistanceKm, elevationDifferenceM }];
  });

  eligible.sort((a, b) => a.stationDistanceKm - b.stationDistanceKm);
  const match = eligible[0];
  if (!match) {
    return {
      status: "unavailable",
      reason: "no-eligible-station",
      station: null,
      distanceKm: null,
      elevationDifferenceM: null,
    };
  }
  return {
    status: "matched",
    reason: "eligible-station",
    station: match.station,
    distanceKm: match.stationDistanceKm,
    elevationDifferenceM: match.elevationDifferenceM,
  };
}
