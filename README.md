# ULTIMATE

A 7v7 Ultimate Frisbee game. It began as a Three.js renderer with a simulation
underneath; the simulation won. Today the repository is two things:

1. **The product: a native iOS game** (`ios/` + `swift/`) — SwiftUI + RealityKit,
   playable on an iPhone. Drag to throw, a cone picks your receiver, real WFDF
   rules run the match, and the AI plays a force and a stack.
2. **The development-time reference: the TypeScript simulation** (`src/sim/`) —
   not shipped and never loaded by the iOS app. It is retained only as an
   independent oracle. Every Swift system is a port of a TS system, validated differentially:
   `tools/gen-goldens.ts` runs the reference and writes JSON fixtures, and the
   Swift suite replays them — **2.2 million assertions, bit-exact where the maths
   allows and inside a stated envelope where libm differs by an ulp.**

The Three.js build still deploys as an unsupported renderer preview
([gsiener.github.io/disc](https://gsiener.github.io/disc/)),
but it is not where the game lives anymore.

> **Status: it plays, and the numbers are the sport's numbers.** Full matches run
> on an iPhone — pulls, stall counts, checks after turnovers, brick marks,
> halftime, timeouts, caps, fouls and picks called by the players themselves, a
> box score. You throw (drag, with a charge window and a receiver cone), you send
> cutters off the disc (tap the space), and you commit a defender at the disc
> (tap). Measured on 15-minute matches: **89.7% completion, 2.4% drops, 3.7 calls
> a game, hucks past 40 m, a laid-out D about once a game** — every target in
> [`docs/release-plan.md`](docs/release-plan.md) met but one: holds sit at **60%**
> against a 65–75% target ([issue #10](https://github.com/gsiener/disc/issues/10),
> a genuinely noisy metric — three re-measurements at growing sample sizes have
> read 64%, 47%, then 60%, none of them in band). Eleven XCUITest gestures verify
> the controls with real touches on pushes; the touch job is deliberately separate
> from the simulator build.
>
> What is left is in [the issues](https://github.com/gsiener/disc/issues), and the
> largest item cannot be done by an agent: **nobody has played it for fun yet.**
> The tests prove every control works; they say nothing about whether it feels good.

## The iOS game

```bash
(cd swift && swift build -c release --product SimTests && .build/release/SimTests)
cd ios && xcodegen generate && xcodebuild -project Ultimate.xcodeproj -scheme Ultimate \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

The app's Play tab runs a live match on a fixed 1/120 s tick (the same dt regime
the entire validation suite runs; see `swift/Sources/UltimateSim/Play/Replay.swift`
for why that is not optional). The other tabs are engineering instruments — the
same check suite on-device, a disc-flight viewer, trajectory plots, and a tick
benchmark — which will be gated behind a debug flag before release.

Controls, in one line: **drag from the disc to throw, tap the grass to send a
cutter, and the same tap on defence sends your best defender at the disc.**

Drag direction aims, drag length is power, and the finish height picks the throw
type (down = dump, flat = backhand/forehand, up = hammer). How long you hold
before letting go sets release quality, with a perfect window at 0.85 s that
narrows per throw type — timing skill buys accuracy, it does not buy aim. A 35°
cone resolves which teammate you meant, scored on angle, lane openness and
distance sanity, and a quality-scaled assist may rotate the release up to 5°
toward the ideal lead. Drag back to where you started to abort. A tap that finds
nobody says so rather than vanishing.

## Why it's interesting

Most of the difficulty in a sports game is not drawing the field — it's that the
sport has to behave like itself.

**The disc really flies.** `DiscPhysics` (both languages) is a 6-DOF rigid-body
model with lift, drag, pitching moment, spin decay, and *gyroscopic precession* —
a spinning disc doesn't tip when you apply a pitching moment; it precesses 90°
out of phase. That single term is why a flat backhand turns over, holds, and
fades at the end of its flight. Hyzer and anhyzer emerge rather than being
scripted.

**Players move like athletes.** `Locomotion` models ground forces as a friction
ellipse rather than clamping axes independently. Consequences fall out: a 90°
cut keeps ~74% of entry speed, backpedalling tops out at 0.55× sprint (which is
*why* getting beaten deep is real), and a layout costs 2.04 s out of the play.

**The rules are the real rules.** Stall to 10 gated on marker proximity (3 m,
disc-space enforced), checks after every stoppage, brick-or-sideline choice on
an OB pull (WFDF 12.4), a pulling team touching its own pull handing the disc
over (12.5), walk-out rules, distinct turnover taxonomy (drop / block /
interception / stall-out / OB / caught-OB), timeouts, caps, and a
self-officiated call machine (fouls, picks, strips, travel, contested/
uncontested) with a box score that reads like UltiAnalytics — holds, breaks,
hockey assists, +/-.

**The AI plays ultimate.** Vertical and horizontal stacks with lane arbitration
so two cuts never share space, front-of-stack-goes-deep / back-comes-under, a
mark that travels around the thrower to the break side, downfield defenders who
never flip their shade, dump activation at stall 4, poach-and-bracket schemes,
and a 3-2-2 zone cup for windy days.

## The differential harness

The Swift port is not trusted because it looks right; it is trusted because the
reference is executable. `tools/gen-goldens.ts` runs the TS systems across
sixteen fixture families — RNG streams, aero coefficients, flight integration,
rules tables, locomotion traces, playbook geometry, full TeamAI decision sweeps,
and two integration-layer fixtures born from mutation testing (the AI throw
solver and the catch decision, each of which had previously been broken in ways
2.2 M component assertions could not see). `SimChecks` is a library, not a test
target, so the identical assertions run in the terminal and on the phone.

The rule the harness enforces: **the reference evolves first.** A gameplay
change lands in `src/sim/`, is mirrored in Swift, and the goldens are
regenerated — never the other way around, and never by editing a JSON.

```bash
node --experimental-strip-types tools/check-goldens.ts # check platform/freshness provenance
cd swift && swift build -c release --product SimTests
.build/release/SimTests                                # replay the goldens
```

The reference must evolve first: regenerate only the fixture families you own with
`node --experimental-strip-types tools/gen-goldens.ts <family> ...`, then run the
freshness check. Do not hand-edit JSON fixtures or regenerate all families casually;
some values are platform-sensitive (#41).

## Focused validation

Install the pinned Node version (`.nvmrc`, currently 26.7.0), then install
dependencies and run the reference/tooling checks:

```bash
nvm use
npm ci
npm test
```

`npm test` is the fast TypeScript validation path: parsing, typechecking
(`src/` and `tools/`), imports, structure, reachability, and golden-generator
tests. `npm run reference:goldens:check` is the focused #41 provenance and
freshness check.

The Swift behavior gate is the differential executable, not the standalone
gameplay scripts:

```bash
cd swift
swift build -c release --product SimTests
.build/release/SimTests
```

The gameplay suites under `tools/test-*.ts` are useful diagnostics and
exploration aids; their known, noisy failures are not a behavior gate for this
repository. The Swift `SimTests` result and the iOS build are the focused
simulation checks.

The only validation that drives the product like a player is the dedicated
`UltimateUITests` XCUITest scheme. Generate the project, choose an available
iOS Simulator (a dedicated simulator is preferred; do not shut down another
agent's device), and run:

```bash
cd ios
xcodegen generate
xcodebuild test -project Ultimate.xcodeproj -scheme UltimateUITests \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  CODE_SIGNING_ALLOWED=NO
```

For a machine whose device names differ, replace `name=...` with an available
simulator UDID from `xcrun simctl list devices available`. CI builds the UI
tests once with `build-for-testing`, then runs the two shards with
`test-without-building`; this keeps boot/build failures distinct from gesture
failures (#46). The suite includes the save/restore and REMATCH lifecycle
coverage added for #43, including the `-savecycle` path. XCUITest is the
player-facing behavior gate; the reference suites do not claim to replace it.

## Repository map

| path | what |
|---|---|
| `swift/Sources/UltimateSim/` | the engine — rules (`GameState` is the single authority), AI, locomotion, disc physics, `Engine` integration |
| `swift/Sources/SimChecks/` | the differential suite + goldens (runs on device and in terminal) |
| `swift/Sources/FlightUI/` | SwiftUI + RealityKit match view, HUD, overlays |
| `ios/` | XcodeGen project for the app shell |
| `src/sim/` | development-only TypeScript reference simulation (the oracle) |
| `tools/` | reference generators/tests plus legacy web capture rigs |
| `docs/adr/` | architecture decisions that are load-bearing and already made — read before proposing a restructure |
| `docs/release-plan.md` | the plan to v1, with measurable authenticity targets — all met |
| `docs/gameplay-design.md` | the design-director brief (camera grammar, controls, legibility, feel) |
| `BRIEF.md` | the original engineering brief — "the reference is FIFA, not Madden" |

## Legacy Three.js preview

The original web build remains only as a renderer preview. It is not a product
target and does not participate in the iOS app. Its zero-binary-assets constraint (every mesh, texture,
environment map and sound generated in code), deterministic screenshot rig
(`tools/capture.mjs`), and blind-review process are documented in
[`BRIEF.md`](BRIEF.md) and [`docs/reviews/`](docs/reviews/).

```bash
npm install && npm run web:dev            # http://localhost:5173 — renderer preview
npm run reference:check                    # typecheck the reference tooling
node --experimental-strip-types tools/test-game.ts   # headless reference match
```

## Note on how this was built

Written by Claude agents working against the contract in `BRIEF.md`. Where an
agent disagreed with a spec, the disagreement is recorded in the code — see the
constants discussion at the top of `src/sim/aero/Coeffs.ts`, or the header of
`swift/Sources/UltimateSim/Play/Engine.swift`, which retracts this project's
most expensive wrong claim (that `Game.ts` was "integration glue rather than
simulation") and accounts for what the claim cost.

## Licence

MIT
