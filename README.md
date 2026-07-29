# ULTIMATE

A 7v7 Ultimate Frisbee game in Three.js, built with **zero binary assets** — every
mesh, texture, environment map and sound is generated in code at load time.

### ▶ [gsiener.github.io/ultimate-threejs](https://gsiener.github.io/ultimate-threejs/)

> **Status: in progress — and what is deployed is a renderer preview, not a
> playable game.** You can fly around a stadium and jump between camera
> framings. You cannot throw a disc: `src/sim/Game.ts` is still a stub, so
> nothing yet connects the (fully tested) input, locomotion, disc-physics and
> rules systems into a game loop. Players render as placeholder capsules.
> See [Current state](#current-state) for the full accounting.

## Controls

Everything is camera control for now — there is no gameplay to drive.

| input | does |
|---|---|
| **drag** | orbit the camera around its target |
| **wheel** | zoom (multiplicative, so it feels the same at 2 m and 200 m) |
| **1**–**0** | jump between the ten named framings — broadcast, sideline, closeup, layout, disc, stadium, turf, crowd, endzone, night |
| **F** | toggle free-fly — **WASD** to move, **Q**/**E** down/up, hold **shift** for speed |
| **R** | toggle slow auto-orbit |
| **H** | hide the overlay |

Quality is auto-detected (mobile → `low`, few cores or little RAM → `medium`,
otherwise `high`; `ultra` is never chosen for you because it costs ~47 ms/frame
on an M1 Max). Override it with `?q=low|medium|high|ultra`. `?debug=1` enables
gizmos, `?seed=N` reseeds the deterministic RNG.

The **night** framing (`0`) and the **stadium** exterior (`6`) currently look
best. The **turf** macro (`7`) shows the procedural grass up close.

## Why it's interesting

Most of the difficulty in a sports game is not drawing the field — it's that the
sport has to actually behave like itself. Two parts of this went deeper than a
demo usually does:

**The disc really flies.** `src/sim/DiscPhysics.ts` is a 6-DOF rigid-body model
with lift, drag, pitching moment, spin decay, and — critically — *gyroscopic
precession*. A spinning disc doesn't tip when you apply a pitching moment; it
precesses 90° out of phase. That single term is why a flat backhand turns over,
holds, and then fades at the end of its flight. None of that is scripted:

| throw | distance | lateral drift | notes |
|---|---|---|---|
| backhand, 20 m/s flat | 37.7 m | 2.29 m left | bank goes `0° → +7.1° → −48.1°` — turn, then fade |
| forehand, 20 m/s flat | 37.0 m | 2.08 m right | opposite curve, as it must be |
| hammer | 18.8 m | 3.00 m | fully inverted, 52° descent, falls off hard |
| huck upwind vs downwind | 17.9 m vs 38.3 m | — | stalls at 36.5° AoA, past the 22.9° stall onset |

Hyzer and anhyzer emerge too: at 26 m/s a flat huck turns over and dumps 17 m
left, while the same throw with 0.25 rad of hyzer holds its line and goes 50.6 m.

**Players move like athletes.** `src/sim/Locomotion.ts` models ground forces as a
friction ellipse rather than clamping each axis independently — the requested
velocity change is decomposed into drive/brake and lateral components and scaled
*uniformly* onto the ellipse. That detail is load-bearing: independent per-axis
clamping leaves a residual sideways force during a near-180° turn that spirals
the player. Consequences fall out of the model:

- 40 m from a standing start in 5.03 s (elite), 5.43 s (average)
- a 90° cut keeps 66.7% of entry speed and costs 1.67 s to regain
- backpedalling tops out at 0.553× sprint speed — which is *why* beating a
  defender deep works: 16.4 m of separation in 5 s
- a layout is 0.558 s of air and 5.14 m of ground, then a slide and a get-up:
  **2.04 s out of the play**, about 15.5 m of coverage conceded

## Architecture

`Engine` owns the GL context, a fixed 1/120 s simulation accumulator and an
ordered system registry. A system is just:

```ts
export class ThingSystem implements System {
  readonly name = 'thing';
  readonly order = 4;                     // lower inits and updates first
  init(ctx: Ctx): void | Promise<void>    // build meshes, bake textures
  update?(dt, ctx): void                  // fixed 1/120 s steps
  lateUpdate?(dt, ctx): void              // after all updates — camera, IK
}
```

Systems never import each other. They communicate through a small event bus
(`disc:released`, `disc:caught`, `score`, `sun:changed`, `player:footstep`, …)
and find peers at runtime via `ctx.sys`, degrading gracefully when one is
absent. That's what let a dozen agents build subsystems in parallel against a
shared contract.

Everything is deterministic — a seeded xorshift RNG (`ctx.rand`), never
`Math.random` — because the screenshot rig depends on the same seed producing
the same frame.

## The screenshot rig

`tools/capture.mjs` drives headless Chrome on the real GPU (ANGLE/Metal, not a
software rasteriser — it checks and warns) and advances the simulation through
`window.__RIG__` in exact fixed steps rather than wall-clock. The same shot name
always produces the same pixels, so an image change means a *code* change.

```bash
node tools/capture.mjs                      # all shots -> shots/
node tools/capture.mjs broadcast turf       # named shots
node tools/capture.mjs --q high --out shots/round2
```

Ten named shots live in `src/capture/Shots.ts`, each pinning camera, framing,
time of day, focus distance and aperture — a broadcast wide, a sideline
telephoto, a chest-up character closeup, a peak-action layout, a disc macro, a
turf macro, the crowd, an endzone score, and a night game.

`tools/compare.mjs` composites two frames as an unlabelled A/B pair, writing the
key to a separate file, so a reviewer's preference is genuinely blind.

## Current state

**Working and tested — 828 assertions across five suites:**

| system | file | tests |
|---|---|---|
| Disc aerodynamics | `src/sim/DiscPhysics.ts` | 104 |
| Rules & box score | `src/sim/GameState.ts`, `Rules.ts` | 373 |
| Team AI | `src/sim/AI.ts`, `Playbook.ts` | 34 |
| Locomotion | `src/sim/Locomotion.ts` | 80 |
| Input | `src/input/*.ts` | 237 |

```bash
node tools/test-disc.ts        # and test-rules / test-ai / test-locomotion / test-input
```

Full WFDF 7v7 rules: stall counting with marker-proximity gating, out-of-bounds
geometry, pulls and brick marks, caps, self-officiated calls, and a complete box
score. Team AI runs vertical and horizontal stacks, force-side person defence
and zone. Input is analogue throughout, with a throw-charge quality curve and
input buffering; humans and AI emit the same intent struct, so both drive the
same code path.

**Builds and runs, but not finished:**

- Stadium, crowd, field, grass, sky, lighting (CSM) and post-processing all
  render, but are mid-iteration — the bowl is over-scaled, the turf aliases, and
  atmospheric haze is too strong.
- Ultra quality tier does not currently render in reasonable time; use
  `--q low` or `--q medium`.

**Not started:**

- Player rig, materials and animation — players are placeholder capsules.
- **The game loop.** `src/sim/Game.ts` is a 9-line stub. Input, locomotion, disc
  physics and rules are each built and tested in isolation, but nothing wires
  them together, so the deployed build is not playable.
- Broadcast camera direction (the camera is a viewer/explorer instead), HUD, audio.

## Blind review

Frames are scored by critics that are not told what they are looking at and are
asked to guess the product tier from the pixels alone, against a rubric where 10
means indistinguishable from a shipped Madden 26 marketing frame.

Round 2 scored **3.33/10, unanimous PROTOTYPE**. All three reviewers independently
named the same root cause — an *inversion of effort*: an ambitious renderer (CSM,
GTAO, scattering sky, single-tone-map AgX chain) drawing a placeholder world of
two-box cars and trees made of three icospheres. The full review, with 28 ranked
defects and fixes across 19 files, is in
[`docs/reviews/round-2.md`](docs/reviews/round-2.md).

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
npm run check        # tsc --noEmit
npm run build        # static bundle -> dist/
npm run preview      # serve the built bundle
npm run shots        # capture all shots -> shots/
```

Deploys to GitHub Pages from `main` via `.github/workflows/pages.yml`. `vite.config.ts`
sets `base: './'` so the same bundle works at a domain root or under a project
subpath without hardcoding the repo name.

## Note on how this was built

Written by Claude Opus 5 agents working in parallel against the contract in
[`BRIEF.md`](BRIEF.md), with a deterministic screenshot rig so that visual work
could be checked by looking at rendered frames rather than by assertion. Where an
agent disagreed with a spec it was given, the disagreement is recorded in the
code — see the constants discussion at the top of `src/sim/aero/Coeffs.ts`, where
the briefed pitching-moment coefficient was rejected on the grounds that it rolls
a flat disc onto its edge in under a second.

## Licence

MIT
