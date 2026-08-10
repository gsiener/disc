# ULTIMATE — engineering brief

An Ultimate Frisbee game in Three.js, targeting the visual and systemic quality
bar of a current-generation sports title. Read this before touching anything.

## There are three codebases and one of them is the oracle

| tree | what it is |
|---|---|
| `src/` | the TypeScript simulation and the Three.js game. **The reference.** |
| `swift/` | a Swift port of the sim (`UltimateSim`) plus its differential suite (`SimChecks`) |
| `ios/` | the SwiftUI app that plays the port |

[ADR-0001](docs/adr/0001-the-typescript-reference-is-the-oracle.md) makes the
TypeScript reference the oracle: Swift mirrors it, and disagreement is settled by
running the reference. That is what makes the port's ~2.25 M assertions mean
something rather than being tautological.

**Read [`docs/adr/`](docs/adr/) before changing a constant or a seam.** The ADRs
are decisions, not suggestions, and three of them will bite you:

- **0004 — pitch-relative constants scale.** A distance is either a fraction of a
  pitch (it scales via `Playbook.depthScale`/`widthScale`, exactly `1.0` at
  regulation) or a genuinely absolute body/air measurement (it does not). Getting
  this wrong produced the most expensive bug in the project's history.
- **0007 — a deliberate divergence from the oracle must be declared.** Swift may
  be correct where the reference is wrong, but the mismatch goes in
  `tools/goldens/divergences.ts` and the suite asserts it is still exactly the one
  declared. An undeclared divergence is indistinguishable from a porting bug.
- **0002 — SimChecks is a library**, so its assertions run inside the shipped app,
  not only in a terminal.

## The default format is minis, not sevens

The game supports both, and **minis is the small pitch that most play happens
on**. A constant that is only right at regulation is a bug, not a simplification.

Note the codebase does not currently agree with itself about the default:
`Play/Engine.swift:233` defaults to `.minis`, `Game/GameTypes.swift:107` to
`.sevens`. Pass the format explicitly rather than relying on either.

## The reference is FIFA, not Madden

Earlier drafts of this brief said "Madden / NBA 2K". That was wrong and it shaped
decisions badly. Ultimate is a **continuous-flow field sport** — no downs, no line
of scrimmage, 7v7 on a large pitch, possession turning over live and play
restarting immediately. FIFA's grammar fits that; Madden's does not.

What this changes, concretely:

- **Camera.** The default is a FIFA "Tele Broadcast"-style elevated sideline long
  lens that *tracks the disc with lead room* and widens as play spreads. Never a
  camera anchored behind a line of scrimmage — Ultimate has none. Cut to a tighter
  follow on a deep cut, a low endzone angle in the red zone, an aerial for the pull.
- **Player switching** is continuous and central, not per-play: cycle to
  nearest-to-disc plus a right-stick manual select, with a clear indicator under
  the controlled player.
- **Passing** maps onto FIFA's through-ball / lofted-pass power meter almost
  directly, including the risk of overcharging. A disc throw is a pass with
  curve, not a snap.
- **Off-ball legibility.** FIFA reads as shape — lines, width, overlaps. Ultimate
  reads as stack, force, cutter lanes and dump resets. Either way the job is the
  same: a viewer must be able to read structure from players who do not have the
  disc.
- **Set pieces.** The pull is a kickoff, not a snap.

Visual references (light, grass, crowd, broadcast presentation) still come from
top-tier sports titles generally; see docs/art-direction.md, which commits to
"summer-evening club final, first TV deal".

## Hard rules

1. **Own your file(s), touch nothing else.** Your task names the file(s) you own.
   Do not edit `src/core/*`, `src/systems.ts`, `src/main.ts`, `src/capture/Shots.ts`,
   `index.html`, or another agent's file. Other agents are editing in parallel;
   a stray edit will be clobbered or will clobber them. If you need something
   from a peer system, read it off `ctx.sys[name]` at runtime and degrade
   gracefully when it is absent.
2. **Zero binary assets.** No downloads, no external URLs, no base64 blobs, no
   `.glb`/`.hdr`/`.png` files. Everything is generated in code — geometry,
   textures, environment maps, audio. Use `src/util/Tex.ts` and
   `src/util/Noise.ts`; do not write your own noise or baking helpers.
3. **Determinism.** Never call `Math.random()`. Use `ctx.rand` (seeded xorshift)
   or a fork of it: `ctx.rand.fork(salt)`. The screenshot rig depends on the same
   seed producing the same frame.
4. **Budget.** Respect `ctx.quality` — it carries per-tier instance counts,
   shadow sizes and post toggles. Your system must run at `low` as well as
   `ultra`. Prefer instancing and GPU work over per-object CPU work.
5. **It must typecheck and it must not spam the console.**
   `npx tsc --noEmit` clean, and no per-frame warnings.

## Architecture

`Engine` (src/core/Engine.ts) owns the GL context, a fixed 1/120 s simulation
accumulator, and an ordered system list. A system is:

```ts
export class ThingSystem implements System {
  readonly name = 'thing';
  readonly order = 4;              // lower inits and updates first
  init(ctx: Ctx): void | Promise<void>   // build meshes, bake textures
  update?(dt, ctx): void                 // fixed 1/120 s steps
  lateUpdate?(dt, ctx): void             // after all updates — camera, IK
  resize?(w, h, ctx): void
}
```

`Ctx` (src/core/Ctx.ts) carries `renderer`, `scene`, `camera`, `composer`,
`time`, `dt`, `quality`, `events`, `rand`, and `sys` (the registry). Read the
file — it is short and it is the contract.

Systems talk through `ctx.events` (a tiny bus), never by importing each other.
Established events:

| event | payload | meaning |
|---|---|---|
| `shot:apply` | `{name, shot}` | screenshot rig is staging a named scenario |
| `sun:changed` | `{dir, color, intensity, hour}` | sky moved the sun; relight |
| `env:ready` | `{texture}` | a PMREM env map is available for IBL |
| `disc:released` | `{pos, vel, spin, throwType}` | a throw left a hand |
| `disc:caught` | `{playerId, pos}` | completion |
| `disc:grounded` | `{pos}` | turnover |
| `score` | `{team, playerId}` | point scored |
| `player:footstep` | `{pos, foot, speed}` | for audio + turf scuffing |

## Field geometry (metres)

Origin is field centre, +Z toward one endzone, Y up. Cones at the eight corners.

| | sevens (regulation) | minis |
|---|---|---|
| playing field | 100 × 37 | 37 × 18 |
| endzone depth | 18 | 6 |
| central "proper" | 64 × 37 | 25 × 18 |
| goal line \| end line | 32 \| 50 | 12.5 \| 18.5 |
| sideline | 18.5 | 9 |
| brick in from goal line | 18 | 6 |
| players per side | 7 | 3 |

`Playbook.depthScale`/`widthScale` are the ratio of this format's dimension to
regulation's, so they are exactly `1.0` at sevens — scaling a constant correctly
is bit-identical there and moves no sevens golden. See ADR-0004.

**The whole minis pitch is 37 m long.** A bare literal like `42` in a distance
ramp exceeds it, saturates everywhere, and the term stops discriminating. That is
not hypothetical; it is issue #17.

## The visual bar

Every frame is judged by a critic that does not know what it is looking at and is
asked to place it against shipped AAA sports titles. What that means concretely:

- **Nothing untextured.** Flat-coloured `MeshStandardMaterial` reads as a
  prototype instantly. Every surface needs albedo variation, a normal map, and
  spatially varying roughness.
- **Micro-detail at every scale.** The frame must survive a close crop: grass
  needs individual blades, cloth needs weave, skin needs pores and specular
  break-up, turf needs wear and divots.
- **Physically plausible light.** Sun is a warm key with a cool sky fill and
  bounce from the turf. Contact shadows matter more than big shadows. Materials
  need energy-conserving roughness, not uniform 0.5.
- **Grounding.** Objects must sit in the world — ambient occlusion in the contact
  region, shadows that tighten near the contact point, no floating.
- **Composition.** Sports broadcast framing: subject off-centre, depth cues from
  foreground occluders and atmospheric falloff, a clear focal plane.

## Verifying your work

```bash
npx tsc --noEmit                       # must be clean
node tools/capture.mjs broadcast turf  # named shots -> shots/*.png
node tools/capture.mjs                 # all shots
```

That is the visual half. **The simulation half lives in
[AGENTS.md](AGENTS.md#verifying-work)** — the six TypeScript suites, the golden
regeneration rule, and `cd swift && swift run -c release SimTests`, which must end
`PASS` with 0 failures. Touching `src/sim/` without running both halves is how a
red commit reaches `main`.

Several of those suite assertions are **red on a clean checkout** and are not
yours; AGENTS.md names which. Diff against a clean worktree before you believe a
failure is your doing.

### capture.mjs photographs a FROZEN TABLEAU. Know which rig you want.

`applyShot()` pins the camera *and* sets `game.posed`, and `Game.update` only
counts the pose hold down when `ctx.capture` is false — so in the shot rig a
tableau is held forever, by design. That is exactly right for judging a material,
a texture or a piece of geometry, and it is useless for judging anything that
moves: a camera, an animation, an interface that reacts to play. The framing you
would be assessing is the framing the pin overrode.

For anything in motion, use the live rig, which releases both locks and
photographs actual play:

```bash
node tools/capture-live.mjs --n 8 --gap 2.5 --q high --w 1280 --h 720 --out shots/mine
```

- **Use `--w 1280 --h 720`.** At 1920×1080 against a 30 M-triangle scene
  Chrome's screenshot path wedges partway through the run.
- **Use your own `--out`** so parallel agents do not overwrite each other.
- It prints `simT`, disc and player positions per frame, and shouts **FROZEN**
  if nothing moved between frames. Heed it. A wedged run still writes plausible
  PNGs and still exits 0 — a frozen series is indistinguishable from a working
  one by eye, and it has already fooled one reviewer on this project.
- Stale `vite` servers accumulate across agent runs and will make it time out.
  `pkill -f "[v]ite"` first if it hangs.

Then **read the PNGs back with the Read tool and look at them.** Do not report
success on code you have not seen rendered. `shots/_meta.json` has the GPU name,
frame time, draw calls, triangle count and any console errors — check it.

Shot names are defined in `src/capture/Shots.ts`; each has an `about` string
describing what it is meant to show. If your system needs a scenario staged
(a player mid-layout, the disc mid-flight), listen for `shot:apply` and pose
yourself accordingly — that is how the critic gets to see your work.
