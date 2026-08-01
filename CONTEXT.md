# SeoulSky

SeoulSky presents an honest, Seoul-specific view of current weather, observed rain, forecast confidence, and learned precipitation reliability. It keeps live presentation, provider comparison, radar delivery, and historical learning coherent without making optional data a prerequisite for the experience.

## Language

**Sky Snapshot**:
The lean, fused weather record that drives the live Seoul scene and primary forecast presentation.
_Avoid_: Main weather payload, fast response

**Weather Intelligence**:
The deferred record that compares forecast providers, explains confidence, and exposes environmental diagnostics.
_Avoid_: Diagnostics payload, detailed weather

**Forecast Provider**:
An upstream forecast source normalized into SeoulSky's shared weather language.
_Avoid_: Vendor, weather API

**Provider Snapshot**:
One coherent forecast-provider reading whose availability, freshness, and normalized weather describe the same observation generation.
_Avoid_: Provider status plus forecast, provider response

**Radar Timeline**:
The ordered, observed-only window of KMA radar frames available for Seoul playback.
_Avoid_: Radar forecast, nowcast

**Radar Frame**:
One immutable, timestamped KMA reflectivity image rendered for the Seoul radar view.
_Avoid_: Tile, radar snapshot

**Reliability Snapshot**:
One versioned whole containing the accumulated forecast history, scored skill history, and current learned weights.
_Avoid_: Data files, weights file

**Reliability Publication**:
The atomic promotion of a validated Reliability Snapshot to durable history.
_Avoid_: Data commit, state push

**Scoring Skip**:
A successful daily reliability cycle that cannot score a completed day because honest forecast or observation evidence is unavailable.
_Avoid_: Failed run, empty score

**Learned Weights**:
Bounded provider influence derived from informative completed precipitation forecasts.
_Avoid_: Model training, provider ranking

**Equal Fallback**:
The safe precipitation weighting used when Learned Weights are unavailable, stale, invalid, or insufficiently trained.
_Avoid_: Default model, zero state
