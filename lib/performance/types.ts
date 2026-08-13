export type CaptureCohort = "06" | "18";

export type PrecipProviderId =
  | "open-meteo"
  | "met-norway"
  | "kma"
  | "pirate-weather"
  | "weather-api";

export interface CapturedProviderForecast {
  provider: PrecipProviderId;
  probability: number | null;
  amountMm: number | null;
}

/** One immutable next-day forecast comparison captured at a fixed KST cohort. */
export interface ForecastCapture {
  stationId: string;
  targetDate: string;
  cohort: CaptureCohort;
  capturedAt: string;
  providers: CapturedProviderForecast[];
  /** Frozen at capture time so later observations cannot leak into the benchmark. */
  frozenBlend: {
    adaptiveProbability: number | null;
    equalProbability: number | null;
    influence: Record<string, number>;
  };
}

export interface PrecipObservation {
  stationId: string;
  date: string;
  observedMm: number;
  observedAt: string;
  source: "kma-asos" | "kma-aws";
}

export interface ObservationStation {
  id: string;
  name: string;
  network: "ASOS" | "AWS";
  latitude: number;
  longitude: number;
  elevationM: number | null;
  activeFrom: string;
  activeTo: string | null;
}

export interface PerformancePolicy {
  windowDays: number;
  halfLifeDays: number;
  reportDays: number;
  minimumSamples: number;
  fullInfluenceSamples: number;
  rainThresholdMm: number;
  decisionThreshold: number;
  weightFloor: number;
  weightCap: number;
  scoreSharpness: number;
}

export interface PerformanceSlice {
  sampleCount: number;
  brierScore: number | null;
}

export interface ProviderRecentPerformance {
  provider: PrecipProviderId;
  /** All comparable completed captures retained for the station/cohort. */
  sampleCount: number;
  /** Comparable captures inside the operating lookback. */
  windowSampleCount: number;
  wetDays: number;
  dryDays: number;
  misses: number;
  falseAlarms: number;
  brierScore: number;
  rainyAmountSampleCount: number;
  rainyAmountMae: number | null;
  last7Days: PerformanceSlice;
  eligible: boolean;
}

export interface PerformanceBenchmark {
  sampleCount: number;
  adaptiveBrier: number | null;
  equalBrier: number | null;
  openMeteoBrier: number | null;
  kmaBrier: number | null;
  status: "passing" | "regression" | "insufficient";
}

export interface LocalPerformanceProfile {
  stationId: string;
  cohort: CaptureCohort;
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  mode: "equal-fallback" | "ramping" | "learned" | "suspended";
  reason:
    | "insufficient-evidence"
    | "benchmark-insufficient"
    | "benchmark-regression"
    | "ramping"
    | "learned";
  confidence: number;
  providers: ProviderRecentPerformance[];
  effectiveWeights: Record<string, number>;
  benchmark: PerformanceBenchmark;
}
