---
title: 'AIWorld is a value type in Swift, so writing into it mid-frame the way the TS reference mutates a shared object silently does nothing'
severity: 'major'
---

## Description

While porting issue #57's fix (AIWorld.scheme, a new channel letting the
offence's chooseFormation read the opposing team's already-decided defensive
scheme), the TS side worked by having `pickScheme` write directly into
`world.scheme[this.team]` — a single mutable object shared by reference across
both team's `update()` calls within the same tick (`Game.ts`'s `this.world`,
and the same pattern in every TS test harness).

The naive Swift port of that same write (`world.scheme[team] = scheme` inside
`TeamAIDefence.pickScheme`) compiles and looks identical, but `AIWorld` is a
`struct`, and every `update`/`pickScheme` signature takes it `_ world: AIWorld`
(by value, not `inout`). The write updates the callee's own local copy and is
silently discarded the moment the function returns — no compiler warning, no
runtime error, just a value that never reaches the other team.

This didn't show up in `swift build` (which is clean either way) or even in a
quick manual read of the diff, which looks like a faithful line-for-line port.
It showed up as 44 failed assertions in the `teamai` differential suite —
`chooseFormation` returning `.vertical` where the golden (generated from the
now-fixed TS reference) said `.horizontal`, at the exact frames where a team
had just called zone. Diagnosed by noticing the failures were all `.../zone`
segments and all downstream-of-formation fields (targetX/Z, effort,
desiredSpeed, debug.role, resetHandler, stackHolding).

## The fix

Two different propagation strategies were needed on the two Swift-side
in-repo call sites, because they have different data lifetimes:

- `Engine.swift`'s `buildWorld()` rebuilds a fresh `AIWorld` every tick (already
  true before this change, and deliberately — see its own doc comment: "a stale
  field here is invisible and produces decisions from last frame's positions").
  Each `TeamAI` already stores its own `scheme` as a persistent instance
  property (only changed when `pickScheme` runs), so `buildWorld` just reads
  `[ai[0].currentScheme, ai[1].currentScheme]` off both team instances directly
  — no write-back needed, just don't discard information that already exists
  elsewhere.
- `TeamAITests.swift`'s `replay()` reuses one `var world` across a whole
  fixture (mutating fields between frames, not rebuilding), which is closer to
  the TS pattern — but still needs the reads to happen BETWEEN the two
  `updateTeam` calls, not once per frame before either, or team 1 sees team 0's
  scheme from the PREVIOUS frame instead of the one just decided this frame:
  ```swift
  let a = updateTeam(teams[0], world, f.dt)
  world.scheme[0] = teams[0].currentScheme   // read back after team 0's own call
  let b = updateTeam(teams[1], world, f.dt)
  world.scheme[1] = teams[1].currentScheme
  ```

## Why this is worth writing down

"Port the TS write into the equivalent Swift line" is not a safe reflex when
the TS side's mutation relies on reference semantics and the Swift type is a
struct. The failure mode is silent at the write site — it doesn't error, it
just doesn't do anything — and only surfaces downstream, in this case as 44
specific-looking differential failures that took some pattern-matching to
trace back to "the new field is always its default value." Any future port of
a TS-side `world.foo = ...` write should ask first: is `AIWorld` passed by
value or reference at every call site that needs to see it? If by value, the
port needs an explicit read-back-and-forward plan (per caller!), not a
line-for-line mirror.
