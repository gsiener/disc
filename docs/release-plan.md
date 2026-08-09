# ULTIMATE — Release Plan v1

*Written 2026-08-09 by a three-lens review: a principal-engineer pass on architecture and
test posture, a coach's pass on rules fidelity and gameplay authenticity, and a
player-experience pass on the app itself. Every claim below was verified against the code
on `main`; file:line citations live in the underlying review reports (task transcripts)
and the task list derived from this plan.*

## The goal

A first release of the iOS game that **fans of ultimate would love**: gameplay that is
recognisably, measurably the real sport — force and stack, stall and check, hucks and
layout blocks, self-officiated texture — wrapped in a game a person voluntarily plays
twice. The reference grammar remains `BRIEF.md` ("FIFA, not Madden": continuous flow,
broadcast camera, pass-with-curve) and the design intent in `docs/gameplay-design.md`,
re-targeted from the Three.js build to the Swift/iOS one.

## Where we are

**The simulation core is release-grade.** GameState is a single rules authority with no
RNG/clock/renderer; the WFDF/USAU rules layer is the most faithful any of the reviewers
had seen in a game codebase (stall mechanics, brick, check, walk-outs, double-team
nuance, a full call/contest machine, an UltiAnalytics-grade stat sheet). The AI plays a
real force and a real stack — front-of-stack goes deep, back comes under, clears leave
the lane, the mark travels around the thrower to the break side. 2.2M differential
assertions pass, and the throw solver now has a 480-case golden against the reference.

**Three things stand between this and the goal:**

1. **The game the player holds isn't the game we validated.** `MatchView` drives the
   engine with wall-clock dt on a `Task.sleep` loop; the entire validation ran at fixed
   1/120. Every launch is the identical match (hardcoded seed). The single highest-risk
   function — `tryCatch`, which decides every catch, drop, block and interception — is
   still unguarded by a golden; mutation testing proved it breaks silently.

2. **It doesn't yet feel like ultimate at the top end.** Measured: 72–79% completions
   (real: 88–96%), ~50% break rate (real offences hold 65–80%), one throw per ~9 s
   (real: 3–6 s), longest completion in 15 min of sevens: 16.7 m — **nobody ever
   hucks**. Throwers drift with the disc (no pivot constraint) and travel is dead code;
   fouls, picks, strips, timeouts and zone are all built and never fire in a match.

3. **It's a sim viewer, not yet a game.** The whole input surface is one drag gesture;
   the cone-select never shows who it picked until after release; a drop, block,
   stall-out and OB all look identical; games end as a permanent freeze-frame (no
   game-over screen); four engineering tabs ship next to Play; no lifecycle handling,
   no persistence, no difficulty, no CI running the suite.

## Progress — updated 2026-08-09

**M0 is complete.** The shipped game now runs the validated dt regime (fixed 1/120
accumulator on a display-linked timeline, clamped so a hitch can't hand the sim an
oversized step), every match draws its own seed, `tryCatch` is pinned by a
differential golden that kills all four previously-surviving mutations, `EngineConfig`
exists as the seam for difficulty and modes, and CI runs the suite plus a simulator
build on every push. CI earned its keep on the first run: it caught a type-check
timeout in `TeamAI.swift` that only reproduces on the older toolchain GitHub ships.

**M1 is roughly half done.** Hucks now exist and are thrown on purpose (1–4 completed
≥30 m per 15-minute sevens match, longest 35.8 m, from a standing start of zero),
release cadence is 5.1–5.5 s against a 4–6 s target, and the thrower has a pivot foot
he may not move — settled drift fell 2.43 m → 0.77 m, and the travel machinery that
had been dead code since it was written is now wired and asserted end to end.

**M2 is mostly done.** The game has a beginning and an end: a pre-game sheet (length,
format, difficulty), first-run coach cards, a live cone-select preview so you see who
your drag means *before* you release, turnover callouts that name what went wrong,
haptics matched to the feel spec, an assist toast that teaches aim honestly, a wind
readout, and a result card with stats and rematch. A release build presents as Play
only.

**Two findings worth carrying forward**, both discovered by measurement rather than
inspection:

1. **The deep game cost completion percentage** — 75% → ~68%, moving *away* from the
   85–92% target. That makes the offence-advantage calibration the necessary
   counterweight rather than an independent item.
2. **~35% of huck attempts go out of bounds**, and hucks cap near 36 m instead of
   40–60 m, because the throw solver has no bank axis — it solves elevation only. The
   disc physics already models hyzer correctly (the same huck flat dumps 17 m left; at
   0.25 rad of hyzer it holds its line and travels 50.6 m). The AI simply never asks.
   Fixing the *cause* is the honest way to buy back completion percentage; inflating
   catch odds is not.

Also found while chasing the deep game: a genuine porting bug in the release
orientation (built from two `fromUnitVectors` calls instead of the reference's basis
construction, so the antiparallel fallback fired on hucks aimed down −x and tilted the
frame by metres). It was invisible until something finally threw far enough to trip
it — an argument for the golden covering ranges the AI could not previously reach.

### What the reviews found (2026-08-09, second pass)

An independent review of shipped `main`, read from a worktree pinned to `origin/main`
so it saw what was released rather than the churning tree, found a **live gameplay
regression that had already shipped** — and the fact that every agent's own checks were
green when it landed is the point.

**The solver bombs every short throw.** Its peak scan brackets a root only via a
*rising* crossing, so when the flattest legal launch already carries further than the
ask, no crossing is recorded and control falls through to the "out of range: throw it as
far as it goes" branch — returning the *maximum-distance* angle. A too-short ask is
misclassified as a too-long one. Measured live: 9.4% of all AI throws overshoot their
aim by more than 3 m; among asks under 6 m it is 42%. Dumps to a receiver a metre away
are released as 21 m bombs. The deeper cause was already solved on the *human* path
(drive an absolute release speed; the comment there describes this exact symptom —
"there was no dump, no reset, no five-metre swing, only bombs") and the AI path never
got that fix.

Two lessons worth keeping:

1. **The failure sat below the bottom of every sweep.** The throw-solver fixture's
   smallest case is 6.93 m; the cliff is at ~5 m. A fixture is only evidence about the
   range it covers.
2. **Coverage was proven absent by mutation, not argued about.** `throwReleaseSpeed`
   was changed in Swift only — altering how hard every throw over 15 m is released —
   and 2,240,645 assertions stayed green, because the function appears in no golden.
   Ports drift silently exactly where no fixture looks.

A third finding, from the deep-cut work: the TypeScript reference had been running its
deep game on a *fallback glide integrator*, because the catch predictor reaches the disc
through the render system, which does not exist headless. The two ports were reasoning
about different discs, and no golden could see it because the trace deliberately sets
that system to `undefined`.

## Success metrics (the definition of "great and accurate")

Measured from headless 15-minute sevens matches unless noted:

| Metric | At review | Now | Target |
|---|---|---|---|
| Completion rate | 72–79% | ~68% ⚠ | 85–92% |
| Holds vs breaks | ~50% breaks | holds > breaks on all seeds | offence holds 65–75% |
| Release cadence | ~9 s/throw | 5.1–5.5 s ✅ | 4–6 s/throw |
| Hucks (≥30 m completions) | 0 | 1–4 ✅ | ≥2 per game, attempted more |
| Huck OB rate | n/a | ~35% ⚠ | well under that |
| Thrower drift | 2.43 m | 0.77 m ✅ | one pivot radius |
| Calls (foul/pick/travel) per game | 0 | 0 (machinery live, AI compliant) | ≥1, resolved through the check machine |
| Point length | ~2.5 min | ~2.5 min | 2–3 min, with timeout/cap endgame |
| Player-visible | freeze at game end | result screen + stats + rematch ✅ | — |
| Loop | wall-clock dt | fixed 1/120, display-linked ✅ | — |
| tryCatch | unguarded | differential golden ✅ | mutations die |
| Throw execution skill | none (quality pinned to 1.0) | in progress | a charge with a perfect window |

## The plan — four milestones

### M0 · Trust what we ship (engineering foundations)
The shipped loop must be the validated loop, and the function that decides the game's
feel must be pinned before we start retuning it (M1 deliberately retunes catch odds —
doing that against an unguarded function is how silent drift starts).

- Fixed-tick accumulator in MatchView, display-linked (reuse `FixedClock`), so ProMotion
  120 Hz is reachable and a frame hitch can't hand the sim a 3× step.
- `tryCatch` differential golden (frozen states + injected roll → outcome), same recipe
  as the throw solver. Kills the known surviving mutations.
- Random match seed per game, surfaced for replay sharing.
- CI: `swift run SimTests` + release-config iOS build on every push.
- Extract `EngineConfig` (formations/force/aggression/tuning constants) — the seam that
  difficulty levels and M2's pre-game sheet need.

### M1 · It feels like ultimate (authenticity)
The coach's ranked list. Order matters: pin tryCatch first (M0), then calibrate.

- **Hucks**: explicit deep-shot valuation (goal proximity + jump-ball win% from
  jumping/speed) instead of pricing 40 m throws through the multiplicative
  completion chain that zeroes them.
- **Offence advantage**: calibrate catch probability / defender roll (`p *= 0.62`,
  interception `* 0.55`) until holds land 65–75%.
- **Tempo**: release every 4–6 s — decision latency, early-stall hold bar, give-go
  continuation after completions.
- **Pivot + travel**: pivot constraint in Locomotion, wire `pivotFoot` into the
  observation; the already-built travel machinery goes live and the visible
  thrower-drift disappears.
- **AI timeouts** (machinery exists, one call away) and **reachable zone** (widen the
  match weather draw past the 4.5 m/s zone threshold so the 3-2-2 cup ever appears).
- **Contact → foul/pick pipeline** feeding the existing `makeCall`/`resolveCall`
  machine — the sport's self-officiated texture. (Largest item; can land after first
  TestFlight.)
- **Caps on a match clock** for the timed-match endgame.

### M2 · It plays like a game (player experience)
- **Live cone-select preview** while dragging (the hooks — `selectedReceiver`,
  `lastAssist` — already exist and nothing reads them).
- **Game-over screen** with personal stats + rematch (fresh seed).
- **Turnover callouts** — DROPPED / BLOCKED / STALLED / OUT OF BOUNDS; the engine
  already distinguishes them.
- **Haptics + assist feedback** (release/catch/turnover; post-throw micro-toast from
  `lastAssist.leadError`).
- **First-run coach overlay** (drag to throw, finish height = throw type, cone picks
  the receiver).
- **Pre-game sheet**: game to 3/5/7 + Easy/Normal/Hard riding the M0 `EngineConfig`.
- **Wind indicator + control-handoff cue.**
- **Off-disc play** (the retention work, both L): tap a teammate to call a cut;
  tap-to-bid on defence so the opponent's possession stops being a cutscene.

### M3 · Ship it (release engineering)
- Lifecycle: pause on `scenePhase != .active`, pause/resume UI, stop hidden-tab tick
  loops.
- Persist in-progress match via `MatchRecorder` (already serialized + tested; wiring).
- Gate the four debug tabs behind a build flag; fix per-frame RealityKit churn
  (per-frame material allocation, entity dict rebuild).
- Replace invariant-dependent force-unwraps (`byId[...]!`, `THROW_SPECS[...]!`) with
  guarded lookups + notes — subs are explicitly anticipated and each becomes a crash.
- Tests for the surfaces that have already silently failed once: marker inference,
  `collectDeadDisc` brick-vs-sideline, stall-out release.
- Docs truth pass: README still says "not a playable game / Game.ts is a stub."

## Sequencing and dependencies

M0 first and strictly before M1's calibration (golden before retune). M1 and M2 then
interleave — authenticity items are sim-side, UX items are app-side, so they
parallelize cleanly. The two L-sized items (foul pipeline, off-disc controls) are the
only things allowed to slip past the first TestFlight build; everything else above is
in it. M3 lands last but CI (in M0) guards the whole run.

## Explicitly out of scope for v1

Gender-ratio/roster rules (correctly n/a for arcade), substitutions (seam exists,
feature doesn't), multiplayer, the Three.js build (frozen as the reference
implementation — it is the oracle, not a product).
