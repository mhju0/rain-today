/**
 * 오늘비 (rain-today) internal weather schema.
 * Every provider response is normalized into these types.
 * Units: temperature °C, wind km/h, precipitation mm, probabilities/percentages 0–100.
 * All time strings are ISO 8601 with an explicit offset (Asia/Seoul or UTC).
 */

export type WeatherCondition =
  | "clear"
  | "partly-cloudy"
  | "cloudy"
  | "overcast"
  | "fog"
  | "drizzle"
  | "rain"
  | "heavy-rain"
  | "snow"
  | "sleet"
  | "thunderstorm"
  | "unknown";

export interface CurrentWeather {
  time: string;
  temperature: number;
  apparentTemperature: number | null;
  humidity: number | null;
  windSpeed: number | null;
  windDirection: number | null;
  precipitation: number | null;
  cloudCover: number | null;
  condition: WeatherCondition;
  /**
   * Richer optional fields populated by Open-Meteo and consumed by the
   * cinematic scene. Other providers may omit them (degrade gracefully).
   */
  windGusts?: number | null;
  rain?: number | null;
  snowfall?: number | null;
  precipitationProbability?: number | null;
  visibility?: number | null;
  isDay?: boolean | null;
  weatherCode?: number | null;
}

export interface HourlyForecast {
  time: string;
  temperature: number;
  precipitationProbability: number | null;
  windSpeed: number | null;
  humidity: number | null;
  condition: WeatherCondition;
}

export interface DailyForecast {
  /** YYYY-MM-DD in Seoul local time */
  date: string;
  temperatureMax: number;
  temperatureMin: number;
  precipitationProbability: number | null;
  condition: WeatherCondition;
  sunrise: string | null;
  sunset: string | null;
  /**
   * Forecast daily precipitation total (mm). Optional enrichment populated only
   * by sources that publish a clean daily amount (Open-Meteo, WeatherAPI); other
   * sources omit it. Consumed by the offline source-reliability batch
   * (lib/reliability) as `predicted_mm`; the live /sky scene ignores it.
   */
  precipitationAmount?: number | null;
}

export type ProviderId =
  | "open-meteo"
  | "met-norway"
  | "kma"
  | "pirate-weather"
  | "weather-api"
  | "open-meteo-air-quality"
  | "airkorea"
  | "rainviewer";

export type ProviderAvailability =
  /** Configured and returning live data */
  | "ok"
  /** Works, but missing optional credentials */
  | "needs-config"
  /** Configured but the last fetch failed */
  | "error"
  /** No official data source exists yet */
  | "unavailable";

export interface WeatherProviderStatus {
  id: ProviderId;
  /** Korean display name */
  name: string;
  availability: ProviderAvailability;
  /** Korean human-readable explanation */
  message: string;
  /** Names only — never values */
  missingEnvVars: string[];
  /** ISO timestamp of the data currently served, if any */
  lastUpdated: string | null;
  fromCache: boolean;
  /** true when an expired cache entry is being served after an upstream failure. */
  stale?: boolean;
}

/** Everything one provider knows right now. */
export interface ProviderSnapshot {
  id: ProviderId;
  status: WeatherProviderStatus;
  current: CurrentWeather | null;
  hourly: HourlyForecast[];
  daily: DailyForecast[];
}

/**
 * A normalized weather warning (기상특보). KMA is the authoritative source, and
 * only when a key is configured — warnings are never invented from forecast
 * probabilities. Missing/failed warning fetches degrade silently to [].
 */
export interface NormalizedWarning {
  /** Stable identity assigned at normalization; includes severity to keep sibling levels distinct. */
  id: string;
  /** Hazard type, e.g. "호우" "강풍" "대설" "폭염" "한파" "황사" "건조" "태풍" "기타". */
  type: string;
  /** Severity. 예비특보 = preliminary watch issued ahead of a formal 특보. */
  level: "주의보" | "경보" | "예비특보" | "기타";
  /** Affected area text exactly as the source provides it. */
  area: string;
  /** ISO KST issue time, when parseable; otherwise null. */
  issuedAt: string | null;
  /** Short Korean headline for display, e.g. "서울 호우주의보". */
  headline: string;
  /** Which source produced this warning. */
  source: ProviderId;
}

/** One RainViewer radar frame (observed past or short nowcast). */
export interface NormalizedRadarFrame {
  /** ISO time (UTC) of the frame. */
  time: string;
  /** RainViewer tile path fragment, e.g. "/v2/radar/5c9a660e5421". */
  path: string;
  /** true = nowcast (near-future), false = observed past frame. */
  nowcast: boolean;
}

/** Full radar state for /diagnostics and the radar route. */
export interface RadarSummary {
  available: boolean;
  frames: NormalizedRadarFrame[];
  /** ISO time of the most recent observed frame. */
  latestObservedAt: string | null;
  /** Tile host (for building tile URLs in a diagnostics layer). */
  host: string;
  /** Required visible credit wherever radar imagery is shown. */
  attribution: string;
  /** Precipitation detected near Seoul in the latest observed frame. */
  precipNearby: boolean;
  /** Precip approaching Seoul (conservative analysis); null when undetermined. */
  approaching: boolean | null;
  /** Korean compass origin of approaching precip; null when not applicable. */
  fromDirection: "서" | "북서" | "남서" | null;
  stale: boolean;
}

/** Lean radar bits the cinematic scene/copy needs (kept out of the heavy payload). */
export interface SkyRadar {
  precipNearby: boolean;
  approaching: boolean | null;
  fromDirection: "서" | "북서" | "남서" | null;
}

/**
 * One KMA radar composite frame (기상청 레이더 합성영상) — the imagery shown in the
 * /sky radar scope. Observed-only (the composite has no nowcast), 5-min cadence.
 */
export interface KmaRadarFrame {
  /** Composite time key, yyyyMMddHHmm in KST (the API's `time` param + proxy `t`). */
  t: string;
  /** ISO instant (UTC) of the frame, for KST display formatting. */
  time: string;
  /** Always false — the KMA composite is observed-only (no nowcast). */
  nowcast: false;
}

/** Lat/lon extent the rendered echo PNG covers, for georeferencing it on the basemap. */
export interface RadarBounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

/** The /api/radar/frames payload: the timeline frame list + required attribution. */
export interface KmaRadarFrames {
  available: boolean;
  frames: KmaRadarFrame[];
  /** Required visible credit wherever the radar imagery is shown. */
  attribution: string;
  /** Geo extent of the echo raster; null/absent when unavailable. */
  bounds?: RadarBounds | null;
}

/**
 * Normalized current air quality. Fused with priority AirKorea → Open-Meteo Air
 * Quality → none. Used to *subtly* shape the scene's haze/visibility — never to
 * produce alarming medical copy. All fields plain + serializable.
 */
export interface NormalizedAirQuality {
  pm25: number | null; // µg/m³
  pm10: number | null; // µg/m³
  ozone: number | null; // µg/m³
  no2: number | null; // µg/m³
  /** Aerosol optical depth (Open-Meteo only) — atmospheric scattering proxy. */
  aerosolOpticalDepth: number | null;
  /** Mineral dust µg/m³ (Open-Meteo only) — 황사 signal. */
  dust: number | null;
  /** UV index (Open-Meteo only) — subtle daytime glare. */
  uvIndex: number | null;
  /** Integrated band 1 좋음 · 2 보통 · 3 나쁨 · 4 매우나쁨 (AirKorea KHAI or derived). */
  band: 1 | 2 | 3 | 4 | null;
  /** Station name (AirKorea); null for the gridded Open-Meteo source. */
  station: string | null;
  observedAt: string | null;
  source: ProviderId;
  stale: boolean;
}

export type ComparisonMetric =
  | "temperature"
  | "rainProbability"
  | "windSpeed"
  | "humidity";

export interface MetricComparison {
  metric: ComparisonMetric;
  values: { providerId: ProviderId; value: number }[];
  min: number;
  max: number;
  spread: number;
  average: number;
  /** 0–100, higher = providers agree */
  agreement: number;
}

export interface ProviderComparison {
  providersCompared: ProviderId[];
  metrics: MetricComparison[];
  /** Dramatic Korean headline, e.g. "강수 예보 불일치 감지" */
  headline: string;
  notes: string[];
}

export type ConfidenceLevel = "high" | "medium" | "low" | "single-source";

export interface ConfidenceScore {
  /** 0–100, null when only one source is live (no cross-validation possible) */
  overall: number | null;
  temperature: number | null;
  rain: number | null;
  wind: number | null;
  level: ConfidenceLevel;
  /** Korean explanation of the score */
  explanation: string;
  /** Answer to "지금 무엇을 믿어야 할까요?" */
  recommendation: string;
}

/** Payload of GET /api/weather */
export interface WeatherIntelligence {
  generatedAt: string;
  providers: ProviderSnapshot[];
  /** Best live snapshot, used for the hero display */
  primaryId: ProviderId | null;
  comparison: ProviderComparison | null;
  confidence: ConfidenceScore;
  /** Environmental sources (air quality + radar), separate from forecast providers. */
  environment: {
    statuses: WeatherProviderStatus[];
    air: NormalizedAirQuality | null;
    radar: RadarSummary | null;
  };
  /** Active official warnings (KMA, when configured); [] otherwise. */
  warnings: NormalizedWarning[];
}

/**
 * Public, non-secret explanation of the historical precipitation weighting used
 * for the current forecast. This is intentionally separate from same-day source
 * agreement: it describes completed-forecast evidence and the runtime safety gate.
 */
export interface PrecipLearningSummary {
  /** False only when the emergency MULTI_SOURCE_PRECIP opt-out is active. */
  enabled: boolean;
  /** True when returned forecast sources participated in the daily precipitation blend. */
  multiSource: boolean;
  mode: "equal-fallback" | "ramping" | "learned";
  /** Stable machine-readable reason for the current mode. */
  reason: string;
  /** 0 = equal weights, 1 = full learned influence. */
  confidence: number;
  /** Informative source-day forecasts incorporated into the learned state. */
  eventsScored: number;
  /** Distinct completed precipitation dates incorporated into the learned state. */
  datesScored: number;
  /** Last successful independent KMA observation cycle. */
  updatedAt: string | null;
  /** Forecast sources available to the current runtime blend. */
  sources: ProviderId[];
  /** Weights actually used today after safety blending and availability renormalization. */
  effectiveWeights: Record<string, number>;
  /** Persisted historical weight profile before runtime safety blending. */
  learnedWeights: Record<string, number>;
}

/**
 * Lean fused payload for the cinematic main page (GET /api/sky). Open-Meteo is
 * the weather baseline; air quality is fused in (AirKorea → Open-Meteo AQ). It
 * stays deliberately separate from WeatherIntelligence. The fast payload carries
 * only a compact precipitation-learning summary; the detailed provider comparison
 * remains deferred so the cinematic scene stays fast.
 */
export interface SkySnapshot {
  /** ISO KST timestamp of the observation Open-Meteo reported. */
  observedAt: string;
  /** ISO timestamp when the server assembled this payload (client uses as "last updated"). */
  fetchedAt: string;
  /** true when served from the in-memory TTL cache rather than a fresh upstream call. */
  fromCache: boolean;
  /** true when upstream failed and an expired cache entry is being served (data identifiably old). */
  stale: boolean;
  current: {
    temperature: number;
    apparentTemperature: number | null;
    humidity: number | null;
    windSpeed: number | null;
    windGusts: number | null;
    windDirection: number | null;
    precipitation: number | null;
    rain: number | null;
    snowfall: number | null;
    precipitationProbability: number | null;
    cloudCover: number | null;
    visibility: number | null;
    isDay: boolean | null;
    weatherCode: number | null;
    condition: WeatherCondition;
  };
  sun: {
    /** Today's sunrise/sunset in ISO KST (Seoul). */
    sunrise: string | null;
    sunset: string | null;
  };
  /**
   * Next ~24h of Open-Meteo hourly forecast (from "now"), used by the data
   * experience's thermal ribbon and forecast orbit. Always present (possibly
   * empty); the cinematic homepage simply ignores it.
   */
  hourly: HourlyForecast[];
  /**
   * Next ~7 days of Open-Meteo daily forecast (high/low, condition, sun times).
   * Already computed by /api/sky for the sun-times pick, so it is shared here at
   * no extra upstream cost; the /sky forecast section's 7-day row reads it
   * directly instead of forcing the heavy /api/weather fetch early in the scroll.
   * Always present (possibly empty).
   */
  daily: DailyForecast[];
  /** Fused current air quality (AirKorea → Open-Meteo AQ → null). */
  air: NormalizedAirQuality | null;
  /** Lean radar approach signal (RainViewer), or null when unavailable. */
  radar: SkyRadar | null;
  /** Active official warnings (KMA only, when configured); [] otherwise. */
  warnings: NormalizedWarning[];
  /** Which source the headline observation (temperature) came from. */
  observationSource: ProviderId;
  /** Every source that contributed to this snapshot, for provenance. */
  sources: ProviderId[];
  /** Safe, always-present learning status consumed by advanced diagnostics. */
  precipLearning: PrecipLearningSummary;
  /**
   * Debug-only (server-gated behind RELIABILITY_DEBUG): how the learned precip
   * weights were applied this cycle. Absent in production and not consumed by any
   * render component; the stable public explanation lives in `precipLearning`.
   */
  precipWeighting?: {
    mode: "equal-fallback" | "ramping" | "learned";
    reason: string;
    confidence: number;
    /** Phase 4: true when the multi-source consensus path ran (flag on + ≥1 source). */
    multiSource: boolean;
    /** Sources that contributed this cycle (returned-only under the flag). */
    sources: ProviderId[];
    /** Effective per-source weights after availability renormalization (sums to 1). */
    weights: Record<string, number>;
  };
}
