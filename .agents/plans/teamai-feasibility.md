# Can `teamai` be retired? A feasibility assessment

Research task for issue #58. **No production code was written and no repo file was
modified** other than this document. Nothing was built or run in `swift/`.

---

## Bottom line

**Yes — with one genuine loss that is smaller than it looks, and one genuine loss that is
NOT in `teamai.json` at all and is currently unflagged in the plan.**

`teamai.json` is 6.3 MB and `TeamAITests.swift` fires ~381,800 assertions off it. Measured
directly against the fixture, that trace contains:

- **1,370 frames × 14 intents = 19,180 intent rows**, of which **96.3% are discretely
  identical to the same player's previous frame**;
- **702 discrete state transitions in the entire trace** — that is every change of `mode`,
  `role`, `state`, `lane`, `cutKind` or action kind, by any of fourteen players, across all
  four segments;
- **66 distinct discrete intent signatures** total;
- **19 cut starts and 17 cut ends**;
- **3 throws**, 1 catch, 1 turnover, 1 pickup, 6 bids;
- a team-state table (`matchup`, `scheme`, `formation`, `force`, `zoneRole`, `marker`,
  `resetHandler`, `stackHolding`) that takes **8, 2, 3, 2, 2, 5, 6 and 18 distinct values
  respectively** across 2,740 rows, and changes **8, 2, 1, 2, 2, 7, 13 and 23 times** in
  the whole trace.

381,800 assertions carrying roughly **seven hundred decisions and three throws**. The
information content is not proportional to the byte count, and the fraction that is
*genuinely un-restatable* is small.

The honest framing of what the golden is: **it is a cross-implementation differential.**
Its purpose was to prove the Swift port agrees with the TypeScript reference. Once the
reference is deleted that question no longer exists, and what remains is a snapshot test —
which the git history confirms it has been treated as: `teamai.json` has been
**regenerated 12 times**, always in the same commit as an intentional AI change
(`4d96bcc`, `64f441b`, `bfc6385`, `4e0c02a`, `4c421c4`, `d91fc8d`, `83323ed`, `09dd60a`…).
It has never blocked a change; it has required one diff-and-regenerate ritual per change.

---

## 1. What `teamai.json` actually pins

`tools/goldens/teamai.ts` builds a deterministic 14-player world and steps `updateTeam` for
both teams across four segments, recording every input before and every `PlayerIntent`
after:

| segment | frames | dt | what it is for |
|---|---|---|---|
| `lineup` | 30 | 1/120 | pre-pull spread; the only place `lineUp` runs |
| `live` | 740 | 1/60 | disc 2 m off the offence's own goal line; person D, real cuts, a scripted throwaway, a scripted loose disc |
| `zone` | 200 | 1/60 | wind at 10.8 m/s, phase bounced through `dead` to re-run `pickScheme` |
| `nomark` | 400 | 1/30 | the four-hundred-second bug: mark set, published count pinned at 0 |

The motion between frames comes from a **crude first-order chase integrator that is
explicitly "NOT a port of anything and never asserted"**. So the fixture is not a
simulation of ultimate; it is a scripted tour of the AI's branch space, and the Swift side
replays the recorded world rather than reproducing it.

`TeamAITests.swift` then asks, per frame:

- **per intent (14 ×):** `id`, `targetX/Z`, `faceX/Z`, `mode`, `effort`, `desiredSpeed`,
  `maxSpeed`, `arriveRadius`, `debug.role/state/lane/cutX/cutZ/cutKind/cutDepth`, and the
  action (kind + typed payload).
- **per team (2 ×):** `stall`, `scheme`, `formation`, `openSign`, `stackAxisX`, `marker`,
  `resetHandler`, `openSideOnD`, `force`, `stackHolding()`, the whole matchup table, the
  whole zone-role table.
- **once:** field geometry, frame-0 intent wiring, and `claims()` — a prose-as-behaviour
  block that is already golden-free in spirit.

---

## 2 & 3. Category breakdown

**Method.** I reconstructed the suite's assertion accounting from the source
(`compareIntent` = 16 base + `mode` + `compareAction`; `compareTeam` = 12; `structural` =
5 on frame 0; `claims()` counted including its two data-driven loops) and multiplied it
against the actual fixture contents parsed with `node`. This reproduces **381,835**
against the stated **381,115** — a 0.19% overshoot, entirely explained by the
`staminaFlips` and `layoutCeilingFlips` skip paths, which replace a full `compareIntent`
with one notice. The model of the suite is therefore correct.

| # | category | assertions | % | restatable? |
|---|---|---|---|---|
| **C1** | **Algebraic identity / pure-function wiring** — `desiredSpeed`, `maxSpeed`, `arriveRadius`, `cutDepth`, `id`, frame-0 `structural`, `geometry` | 95,975 | **25.1%** | **Yes, trivially.** These are closed-form one-liners at the single `PlayerIntent` construction site (`TeamAI.swift:857-869`) over quantities already in the frame. `arriveRadius` takes **3 distinct values in the whole trace**; `cutDepth` takes **5**. |
| **C2** | **Stated-rule decisions** — `mode`, `role`, `state`, `lane`, `cutKind`, action kind, throw type/receiver, all 12 team-state fields, per-frame intent count | 149,336 | **39.1%** | **Yes.** Every one is a discrete label produced by a documented rule. |
| **C2′** | *(sub-category of C4, reclassified)* — `cutX`/`cutZ` where the value is NaN, i.e. "this player has no cut" | 35,282 | **9.2%** | **Yes** — pure redundancy with `cutKind == nil`, already in C2. |
| **C3** | **Emergent/statistical claims** — the `claims()` block and the `observed` census | 1,095 | **0.3%** | **Already the target pattern.** Reads counts off the fixture today; would read them off a live pool instead. |
| **C4** | **Continuous positional outputs** — `targetX/Z`, `faceX/Z`, `effort`, real (non-NaN) `cutX/Z`, numeric action payloads (`stall.count` 871, `catch.difficulty` 265, throw payload 24, bid 12) | 100,147 | **26.2%** | **Mostly yes, as bounded geometric properties. This is where the residual loss lives.** |

Totals: 381,835. C1+C2+C2′+C3 = **73.7% restatable with no loss of the question being
asked.** C4 = **26.2%**, of which I estimate (below) that the un-restatable residue is
**under 3% of the whole suite**.

### The redundancy multiplier, stated separately

This is orthogonal to the categories and it dominates:

| measure | value |
|---|---|
| intent rows identical to the same player's previous frame | 1,437 / 19,180 (7.5%) |
| **discrete part** of an intent identical to previous frame | **18,464 / 19,180 (96.3%)** |
| team rows identical to previous frame | 1,375 / 2,740 (50.2%) |
| `cutX` is NaN | 17,641 / 19,180 (92.0%) |
| total discrete transitions in the trace | **702** |
| distinct discrete intent signatures | **66** |

The AI runs an **8 Hz decision tick** while the trace samples at 60–120 Hz, so most frames
are the previous decision re-emitted. The suite already discovered this once and fixed one
instance of it — `structural()` was cut from 95,705 identical comparisons to 70, with a
doc comment that says exactly why. The same argument applies to most of C1 and C2.

---

## 4. Four worked examples

### 4.1 The mark — 621 `mode: mark` intents, 672 `role: marker` (C2 + C4)

**What the golden asserts today.** For every frame with a marker, a recorded `targetX`,
`targetZ`, `faceX`, `faceZ`, `effort`, `desiredSpeed`, `maxSpeed`, `mode == "mark"`,
`state == "mark"`, `arriveRadius == 1.5`, plus the team row's `marker` id and `stall`.
~14 assertions × 621 frames ≈ 8,700.

**What the code actually says** (`TeamAIDefence.swift:275-330`) is a three-branch rule,
already written in prose in the source:

1. base case: target = `Playbook.markPoint(thrower, odir, breakSign, PLAY.markDistance)`;
2. **sweep branch** — if the bearing error exceeds 0.45 rad and radius < 4.2 m, the target
   sits *on* the stand-off circle at `markDistance` with only the bearing stepped by
   `clamp(dBear, ±0.65)` (the marker spirals in rather than orbiting out);
3. **disc-space branch** — if the anticipated position (0.28 s of relative velocity ahead)
   is inside `discSpace + 1.10`, the target moves to radius `discSpace + 1.75` at bearing
   `bearNow + clamp(dBear, ±0.55)` — *along the circle toward the break side*, not radially.

**Native replacement.** Over a `MatchPool`-style pool of real matches, for every frame with
a live marker:

- `dist2(target, thrower) ∈ {markDistance, discSpace + 1.75}` to 1e-12 — the target is
  always on one of exactly two circles. (This alone is a stronger statement than 621
  recorded coordinate pairs, because it holds for every geometry the pool reaches, not the
  one this trace happened to walk.)
- the target is on the break side of the thrower (`sign(cross(goalDir, target - thrower))
  == breakSign`) **or** the bearing error to the break side strictly decreased this frame —
  which is the sweep's actual promise and the thing the current fixture states only by
  coincidence of the recorded numbers.
- `dist2(marker, thrower) >= PLAY.discSpace` on every frame the marker is inside 4.2 m —
  legality, which the golden never asserts as such.
- once the count runs, the marker stays inside `markMax` (the coupling `claims()` already
  half-checks arithmetically).
- `mode == .mark ⟹ arriveRadius == 1.5` and `state == "mark"` — one assertion, not 621.

**Verdict: strictly stronger.** The golden pins one trajectory; the property pins the
locus. A regression that moved the mark to the open side would be caught by both; a
regression that put the marker inside disc space in a geometry this trace does not visit
would be caught only by the property.

### 4.2 The matchup table — 2,740 assertions, 8 distinct values, 8 changes (C2)

**What the golden asserts.** The full comma-joined matchup string every frame, per team.
The suite's own comment says this is "the single most order-sensitive structure in the
port: the reference iterates a JS `Map` and keeps the LAST defender matched to the
thrower. Comparing the whole table every frame is what makes an unordered container fail
loudly instead of intermittently."

**This concern has already been designed out.** `TeamAI.swift:76` defines
`OrderedIntMap<Value>` with an explicit `order` array and an `entries` accessor, and the
mark selection reads `for e in matchup.entries where e.value == thrower.id { matched = e.key }`
— last-wins, in insertion order, *stated in the type*. The 2,740 assertions are re-proving
by example a property the container now guarantees by construction.

**Native replacement.**

- `OrderedIntMap` gets its own unit tests: insertion order preserved across `set` of an
  existing key, `entries` order stable, last-wins semantics for the reverse scan. ~20
  assertions, and they are the actual claim.
- Over the pool, per frame: the matchup is a **total injective function** from our seven
  defenders onto seven distinct opponents (nobody unmarked, nobody double-marked) whenever
  the scheme is `person` — a property the golden never states and which is what the
  original bug ("the mark is handed to a defender six metres away and the count restarts
  every frame") would actually violate.
- The mark-swap rule: if the matched marker is > 6 m from the thrower and a candidate is
  > 1.5 m closer, the assignments swap and no defender is left with two marks.
- Matchup churn per possession is bounded (assignments do not thrash frame to frame) —
  measurable over a pool, and the direct statement of "the count restarts every frame".

**Verdict: strictly stronger, and the fixture's own stated reason for existing is now a
type invariant.**

### 4.3 The cut lifecycle and lane reservation — 19 cut starts in 6.3 MB (C2 + C4)

**What the golden asserts.** `lane`, `cutKind`, `cutX`, `cutZ`, `cutDepth` per intent —
76,720 assertions, of which 92% are `lane == ""` and `cutX == NaN` ("this player is not
cutting"). The real content is 19 cut starts, 17 ends, and 18 distinct `(cutX, cutZ)` pairs.

**The bug class the generator names** — "a lane reserved by a cut that ended, so nobody may
ever cut there again" — is a *leak*, and a leak is exactly what a property catches and a
trace catches only by luck. The trace has to happen to run out of lanes.

**Native replacement.** Over the pool, every frame:

- `liveLanes` contains exactly the lanes of the currently-live cuts — no orphans. Directly
  falsifiable, per tick, and this is the named bug.
- no two live cuts share a lane; live downfield cuts ≤ 2; live cut targets ≥ 5 m apart.
  (**These three already exist verbatim in `tools/test-ai.ts`.**)
- every cut that starts either completes or is ended, within `cutT` bounds — no cut lives
  past its clock.
- a cut's route target is ≥ `MIN_CUT_RUN` (1.8 m) from the cutter's feet, in bounds after
  `clampToField`, and on the lane's own side. `HumanCutTests` already asserts the 1.5 m
  version of this for commanded cuts.
- `cutKind == nil ⟺ cutX.isNaN` — one assertion replacing 35,282.
- the vocabulary is exercised: `deep` and `under` both occur, deep cuts start from the
  front of the stack and unders from behind them. (Also already in `test-ai.ts`.)

**Verdict: strictly stronger.** The golden's 19 samples become a per-tick invariant over
thousands of cuts.

### 4.4 The throw decision — 3 throws in the whole fixture (C4)

**This is the finding that most changes the risk picture, and it points the opposite way
from the intuition that `teamai` is the hard one.**

`teamai.json` contains **three** `action: throw` rows. The full throw payload — `aim.x/y/z`,
`speed`, `flightTime`, `spin`, `receiverId`, `expected` — is asserted **30 times** in
381,835 assertions (0.008%). `evaluateOptions`, `possessionValue`, `laneBlockage`,
`separationAt`, `bidChance`, `wantsBid` — 790 lines of `TeamAIThrow.swift`, the part of
the AI a player would actually notice — are essentially **not covered by this fixture at
all**. The `mode: throw` count of 36 is windup frames, not decisions.

The `nomark` segment adds 2 more throws. Total behavioural throw coverage in 6.3 MB: **five
releases.**

**What the golden was actually doing here** is pinning `stall` counts (871 assertions) and
`catch.difficulty` (265) — the bookkeeping around throws, not the decisions.

**Native replacement.** Nothing needs replacing, because nothing is there. What *does*
cover this today is `EngineTests`' huck and completion assertions and `tools/test-ai.ts` —
see the loss section below.

---

## 5. How far the `StoppageTests` / `MatchPool` pattern stretches

Very far, and further than the plan currently assumes.

`MatchPool` plays **eleven fifteen-minute sevens matches once** (seeds `[11, 23, 37, 2, 5,
7, 13, 19, 29, 41, 53]`, `120 × 900` ticks each) and records everything three suites want
in a single pass. `StoppageTests` then asserts over that pool with no golden at all, and
its header states the discipline the owner wants: *"the reachability checks are written to
be immune to the tail-statistic problem… a check that can only be made green by re-rolling
a seed is not a check."* Floors are pooled, not per-seed; the weather is pinned wherever
the point of the check is the zone.

**21 of the 42 suites in `SimChecks` already load no golden**, including `EngineTests`
(100 KB), `TickLoopTests` (38 KB), `HumanCutTests` (33 KB) and `HumanDefenceTests` (25 KB).
The pattern is established, and `HumanCutTests` in particular is a working example of
asserting `TeamAI` internals natively (it reaches into the live `TeamAI` via a
`teamAI(_:_:)` helper and checks lane claim/release, ghost expiry and rate limiting).

**Three things the pattern needs that it does not have yet:**

1. **Observation of `TeamAI` internals per tick.** `MatchPool.Match` currently records
   engine-level aggregates. Lane occupancy, matchup injectivity, stack residual and mark
   geometry need per-tick sampling of the AI. That is a new `Match` field group and a
   sampling hook, not a new architecture — the pool already samples per-tick for
   `worstThrowerDrift` and `worstPivotReach`.
2. **A pinned-condition pool.** Zone, heavy wind and the pinned-goal-line situation are
   rare or absent in eleven default matches. `StoppageTests.theSetPlayTimeoutIsReachable`
   already shows the move: a second, differently-configured pool for the branch the default
   format never reaches. `teamai`'s `zone` and `nomark` segments become exactly that —
   `nomark` in particular is not a pool check at all but a **scenario**: build a world, pin
   `disc.stall` at 0, run 400 ticks at 1/30, assert a throw happens inside 13 s. That is a
   versioned replay scenario in the issue's sense and it is ~40 lines.
3. **Runtime budget.** Eleven matches is already 513 s of the suite's 640 s before
   `MatchPool` deduplicated them. Adding per-tick AI sampling is cheap; adding a second and
   third pool is not free. Budget for it explicitly.

---

## 6. What is genuinely lost — flag these

### 6.1 The un-restatable residue inside `teamai` — small, and I can bound it

Of C4's 100,147 continuous assertions, the parts that are **not** a stated rule:

- `faceX`/`faceZ` (38,360) — facing is "look where you are going, or at the disc, or at
  your man". Assertable as a *unit vector pointing at one of a small set of things*, but
  the blend/hysteresis between them is tuning, not rule.
- `effort` (19,180) — e.g. `clamp(0.35 + gap * 0.45, ...)`. A magnitude with a monotonicity
  story (more gap → more effort, bounded [0,1]) but the coefficients are taste.
- `targetX`/`targetZ` (38,360) in the states where the target is a *tuned station* rather
  than a geometric construction — the stack slot offsets, the handler stations, the
  clearing waypoints.

For all of these, a property suite can state **shape** (bounded, in-bounds, monotone in the
right argument, on the right side, converging) but not **value**. A change that moved a
station by 0.5 m without crossing any bound would go red under the golden and green under
properties.

**But**: the golden cannot tell you whether that change is a bug or an improvement either.
It goes red, and the documented response — 12 times in this repo's history — is to
regenerate. So the coverage being lost is *"an unexplained 0.5 m move gets a human's
attention once"*, which is real but is a code-review function, not a test function. I put
the genuinely un-restatable residue at **~2-3% of the suite** (the tuning-value component
of `effort` and the station targets), and its practical prospective value at close to zero
given the regenerate-on-change history.

### 6.2 THE REAL LOSS, AND IT IS NOT IN `teamai.json`: `tools/test-ai.ts`

**This is the thing I would not want the owner to discover after deletion.**

`tools/test-ai.ts` is 2,008 lines and **~70 assertions**, and it is *already* the
Swift-native-style behavioural specification this exercise is trying to write — except it
is in TypeScript, it imports `src/sim/AI.ts` directly, and it is inside the deletion scope.
Its own header states the property the owner wants:

> *"Every one of these is derived independently of the AI's own bookkeeping — from player
> positions and an independent derivation of the open side — so the assertions cannot be
> satisfied by the AI simply agreeing with itself."*

It asserts, over real multi-point simulations at 1/120:

- **spacing/cuts** — ≤ 2 live downfield cuts; no two live cuts share a lane; cut targets
  ≥ 5 m apart; stack keeps ≥ 2 m between bodies; deep cuts from the front of the stack,
  unders from behind; the up-line is reachable and its abort is live code.
- **shape** — stack RMS perpendicular residual ≤ 2.0 m (total least squares about the
  cutters' own best-fit line); column axis alignment ≥ 0.80 with the attacking direction;
  gap average ≥ 3.4 m with ≤ 25% tight; the stack sits 5-20 m downfield of the disc; lane
  occupancy ≤ 0.45; a dead cut clears in ≤ 2.0 s on average.
- **the reset** — a handler stationed behind the disc on ≥ 90% of held frames, ≥ 95% at
  stall ≥ 7, and open on ≥ 70% at stall ≥ 7.
- **the force** — the mark is *positionally* on the break side ≥ 95%; downfield defenders
  shade the open side ≥ 85%; the offence's read of the force agrees with the mark ≥ 90%;
  marker inside 3 m on ≥ 99% of stalling frames and outside 1 m disc space always.
- **outcomes** — completion 62-95% per match and 75-92% across seeds; windy completion
  70-98%; heavy wind triggers zone; turnovers from several causes; layouts < 0.35 per
  completion and never for a disc that could be run down.
- **hygiene** — nobody leaves the field (0 OOB player-ticks); nobody oscillates in place;
  stamina depletes and recovers within bands; same seed → identical simulation; rejects
  mis-shaped peers without NaN; runs with an empty `ctx.sys`.
- **a frozen stall count cannot deadlock the match** — the `nomark` claim, already stated
  behaviourally here.

The friction log confirms this is the file that actually catches AI regressions.
`.agents/friction-log/20260813180828-issue-57-phase/` documents issue #57 Phase 1a in
detail: three of four candidate fixes were rejected on evidence from `test-ai.ts` and the
Swift real-engine assertions, and `teamai.json` played no diagnostic role — it was
*regenerated afterwards*. The entry states plainly: *"`tools/test-ai.ts` alone would have
shipped v1 as correct (it has no huck assertion), and the Swift `SimTests` alone wouldn't
have caught the calm-day/completion-holds regression."* Both halves are needed; one half is
scheduled for deletion.

**Swift coverage overlap today** (from grepping the golden-free suites): completion rate,
huck existence, deep-shot valuation firing, mark legality and the count, lane claim/release
for *commanded* cuts, cut-direction correctness — all present. **Missing entirely on the
Swift side:** the whole `shape` section (stack residual, column axis, spacing evenness,
lane occupancy, clearing time), the reset stationing/openness percentages, the break-side
force percentages, out-of-bounds, oscillation, stamina bands, formation station validity,
and the windy-completion band.

**Recommendation: treat `tools/test-ai.ts` as a first-class migration target, at higher
priority than `teamai.json`.** It is ~70 assertions of real, independently-derived,
statistical specification and it is the one artefact in the deletion set whose loss is not
recoverable by reading the Swift source.

### 6.3 Two smaller flags

- **`Check` volume.** The suite reports 2,160,775 assertions across `SimTests`.
  Retiring `teamai` drops ~381k of them (~18%). If any process, dashboard or habit reads
  that number as a health metric, it will read as a regression. Say so in the commit.
- **The `LAYOUT_CEILING` divergence.** `TeamAITests.compareIntent` carries the only live
  exercise of ADR-0007's declared divergence, keyed on a bid at `land.y ∈ [1.10, 1.85)`
  observed at `f1237-1238/i11`. Once the reference is gone the *divergence* is gone too
  (there is nothing to diverge from), but the underlying claim — that 1.10 m is the reach
  ceiling of a prone body and that `wantsBid` respects it — should be restated as a direct
  `shouldBid`/`wantsBid` property test before `DivergenceTests` is deleted. It is ~10 lines
  and is easy to lose in the sweep.

---

## 7. Recommended plan of attack

Ordered so the risky question is answered first, matching the issue's own advice.

**Phase A — port `tools/test-ai.ts` to Swift before deleting anything. (~2-3 days)**
This is the load-bearing step and it is independent of `teamai.json`. New
`TeamAIShapeTests.swift` + an extended `MatchPool` sampling group. Most of the 2,008 lines
are the TS-side world stub and integrator, which Swift does not need — the real engine
replaces it. The assertions themselves and their independent derivations (best-fit line,
open-side derivation, lane occupancy) are maybe 500 lines of real content. Port the
thresholds **as measured, then re-measure on the Swift pool and adjust once, in one commit,
with the numbers written down** — do not port a band and then widen it later.
*Risk: the thresholds were tuned against the TS engine's dice. Expect one round of
re-measurement; budget for it rather than discovering it.*

**Phase B — the mechanical categories. (~1 day)**
- C1 (25%) → `IntentWiringTests`: the construction-site identities, asserted once per
  distinct `(mode, settle)` combination rather than 19,180 times. Frame-0 `structural` is
  already this shape and its doc comment is the argument.
- C2 team-state (33k) → `OrderedIntMap` unit tests + per-tick matchup injectivity/totality
  over the pool + scheme/force/formation transition rules.
- C2 cut fields → the lane-leak invariant and `cutKind == nil ⟺ cutX.isNaN`.

**Phase C — the scenarios. (~1 day)**
Three versioned replay scenarios, each a self-describing Swift function with no fixture:
- `nomark`: pin the published count at 0, run 17 s, assert a release inside 13 s, a working
  dump, and a genuinely established mark. Directly ports today's `claims()` block.
- `pinnedOnOwnGoalLine`: disc 2 m off the own line; no reset cut and no stationed handler
  targets ground behind the floor; `possessionValue` keeps falling past 64. Today's
  `claims()` loop, over a live world instead of a recorded one.
- `zoneUnderWind`: wind 10.8 m/s, phase bounced through `dead`, assert `pickScheme` calls
  zone, the force re-points upwind, all seven zone roles are assigned exactly once, and the
  cup applies a count.

**Phase D — the geometric properties. (~1-2 days)**
Mark locus, cut route validity, stack/station bounds, facing-vector shape, effort
monotonicity and bounds. This is where C4's restatable majority lands.

**Phase E — delete, and mutation-test. (~0.5 day)**
Delete `teamai.json`, `TeamAITests.swift`, `tools/goldens/teamai.ts`. Then do what was done
for `rng`: introduce 8-10 deliberate bugs in `TeamAI*.swift` — a lane never released, a
matchup swap that drops an assignment, the mark on the open side, a stack rotation that
loses a body, `markDistance` off by a metre, an inverted force, an RNG draw on the wrong
branch, a station 2 m out — and confirm the new suite catches each. **Do not delete before
this passes.** Record the score the way the `rng` pilot did; that number is the actual
answer to "did we lose coverage", and it is worth more than any estimate in this document.

**Total: roughly 5-7 focused days**, of which Phase A is the half that matters and the half
that is currently unscheduled.

---

## 8. Summary table

| question | answer |
|---|---|
| Can `teamai.json` be retired without losing real coverage? | **Yes, with a ~2-3% residue that is tuning-value pinning, not behaviour.** |
| Is the 6.3 MB proportional to the coverage? | **No.** 702 discrete transitions, 66 distinct signatures, 19 cuts, 5 throws. |
| Does the fixture cover throw decisions? | **Almost not at all** — 30 of 381,835 assertions. |
| Is the "matchup map iteration order" concern still live? | **No** — `OrderedIntMap` makes it a type invariant; test the container. |
| Is the `StoppageTests` / `MatchPool` pattern enough? | **Yes**, plus per-tick AI sampling and two pinned-condition pools. |
| What genuinely cannot be replaced from the Swift source alone? | **`tools/test-ai.ts`'s ~70 independently-derived behavioural assertions** — port them first. |
| Second flag | Restate the `LAYOUT_CEILING` reach-ceiling claim as a `wantsBid` property before `DivergenceTests` goes. |
| Third flag | The suite's headline assertion count drops ~18%; say so deliberately. |
