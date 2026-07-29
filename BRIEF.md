# ULTIMATE — engineering brief

A 7v7 Ultimate Frisbee game in Three.js, targeting the visual and systemic
quality bar of a current-generation sports title (Madden / NBA 2K). Read this
before touching anything.

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

## Field geometry (regulation, metres)

Playing field 100 × 37, endzones 18 deep at each end, so 64 × 37 of central
"proper" plus two endzones. Brick marks 18 m in from each goal line. Origin is
field centre, +Z toward one endzone, Y up. Cones at the eight corners.

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

Then **read the PNGs back with the Read tool and look at them.** Do not report
success on code you have not seen rendered. `shots/_meta.json` has the GPU name,
frame time, draw calls, triangle count and any console errors — check it.

Shot names are defined in `src/capture/Shots.ts`; each has an `about` string
describing what it is meant to show. If your system needs a scenario staged
(a player mid-layout, the disc mid-flight), listen for `shot:apply` and pose
yourself accordingly — that is how the critic gets to see your work.
