# 오늘비

오늘비 presents a South Korea local rain forecast whose provider influence can adapt to recently observed performance at a nearby official station. The exact-coordinate forecast and station-based evidence are distinct concepts and must remain visibly distinct.

## Language

**Forecast Location**:
The user-selected coordinate where every provider forecast is requested.
_Avoid_: User station, saved location

**Location Candidate**:
A selectable, fully qualified Korean administrative or legal area with a representative coordinate and source-scoped identity.
_Avoid_: Search hit, exact location

**Area Representative**:
The provider-supplied coordinate used as the Forecast Location after a Location Candidate is selected. It represents the named area, not the user's position.
_Avoid_: User location, neighborhood center

**Device Location Selection**:
A Forecast Location supplied by browser geolocation together with the browser's temporary horizontal-accuracy estimate.
_Avoid_: Exact address, saved location

**Observation Station**:
An official KMA station supplying completed precipitation ground truth.
_Avoid_: User location, exact local weather

**Station Match**:
The nearest active observation station that passes distance and elevation representation gates for a Forecast Location.
_Avoid_: Nearest station, local truth

**Capture Cohort**:
One fixed 06 or 18 KST next-day forecast issue group. Cohorts are evaluated independently.
_Avoid_: Morning data, forecast batch

**Forecast Capture**:
One immutable set of next-day provider predictions and prospectively frozen blend outputs for an Observation Station and Capture Cohort.
_Avoid_: Current forecast, historical API response

**Completed Comparison**:
A Forecast Capture joined to the later station-day observation for its target date.
_Avoid_: Accuracy sample when the observation is missing

**Seed Comparison**:
One retrospective day-ahead provider forecast, rebuilt from a public archive and joined to the station-day observation for its target date. Carries an amount but no probability, no Capture Cohort, and no frozen blend, so it is never a Forecast Capture and never enters the Prospective Benchmark.
_Avoid_: Backfilled capture, historical forecast, synthetic sample

**Recent Performance Profile**:
The cohort-specific provider metrics, evidence state, effective weights, and prospective benchmark for one Observation Station.
_Avoid_: Accuracy ranking, trained model

**Effective Influence**:
The normalized provider weights actually used for the current request after evidence gates and present-provider renormalization.
_Avoid_: Accuracy percentage, confidence

**Equal Fallback**:
Equal influence among providers with valid current values when local evidence is missing, insufficient, suspended, or unavailable.
_Avoid_: Zero state, failed forecast

**Prospective Benchmark**:
The adaptive and equal-weight probabilities frozen before outcomes and later scored on the identical completed comparison set.
_Avoid_: Backtest, simulated improvement

**Benchmark Suspension**:
The state that prevents learned influence when the prospective adaptive blend regresses against equal weighting or lacks enough fair comparisons.
_Avoid_: Provider failure, no forecast
