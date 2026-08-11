# ADR-0008 — Swift is the product; TypeScript is a development-only oracle

- **Status:** Accepted
- **Date:** 2026-08-11

## Context

ULTIMATE began as a Three.js application. The shipped game is now the SwiftUI /
RealityKit app backed by `UltimateSim`; no TypeScript or WebGL code is linked
into it. Keeping the old directory layout made this easy to misread as a hybrid
runtime, and `src/sim/Game.ts` had accumulated imports from visual entities.

Deleting the executable reference would make the committed JSON goldens the
only remaining specification. Those goldens cover deliberately selected cases;
they cannot discover a new disagreement outside their fixture surface.

## Decision

`swift/` and `ios/` are the only supported product path. New application UI,
input, persistence and rendering belong there.

`src/sim/` remains solely as a development-time, headless reference used to
generate goldens and diagnose port disagreements. Its target dependency
direction is away from the web preview: reference code may depend on simulation
modules and minimal math/runtime adapters, but not on render systems, capture
scenarios, meshes, materials, DOM, or GL context. `GameSystem` is transitional
and still has capture/input adapters; no new dependency of that kind may be
added, and they are moved behind adapters incrementally. `DiscRuntime` is the
first extraction, owned by `src/sim/DiscRuntime.ts`; `DiscSystem` observes it.

The Three.js application remains an explicitly legacy preview. It is a consumer
of the reference model, never its owner, and must not define behaviour needed by
the Swift game.

## Consequences

This keeps the high-value independent implementation without suggesting that the
product has two runtimes. It also makes eventual retirement possible: before
deleting TypeScript, replace the executable oracle with a consciously accepted
Swift-native specification (versioned replay scenarios, invariants, and
match-level acceptance cases) and demonstrate equivalent coverage.

The reference still imports `three` for vector and quaternion maths today. That
is a library dependency, not a web-runtime dependency; removing it is a later
mechanical substitution after the rendering seams are gone.
