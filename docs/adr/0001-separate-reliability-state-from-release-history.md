---
status: accepted
---

# Separate reliability state from release history

SeoulSky publishes each validated Reliability Snapshot to a dedicated reliability-state branch instead of main. This preserves Git's atomic history and existing repository credentials while preventing daily learning updates from becoming application releases; Vercel deployment is explicitly disabled for the state branch.

## Considered options

- Keep state on main: simplest storage, but every successful daily cycle enters the production release path.
- Use a separate repository or object store: stronger infrastructure isolation, but adds credentials, operational setup, and a new durable-storage implementation.
- Use a dedicated branch in this repository: retains atomic Git publication, recovery history, and the existing raw read path without new infrastructure.

## Consequences

The branch must be seeded from the current Reliability Snapshot before state is removed from main. The scheduled transaction may publish only the canonical snapshot, must fast-forward from the observed branch revision, and must fail closed on malformed or regressing history. Runtime code reads learned weights from the dedicated branch; local output is ignored on main.
