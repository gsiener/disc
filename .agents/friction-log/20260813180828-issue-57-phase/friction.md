---
title: 'Issue #57 Phase 1a: laneBlockage''s tail cutoff, gated on zone, fixes windy completion without huck/calm-day collateral'
severity: 'major'
---

## Description

Issue #57 Phase 1a: fixed the pricing-blindness mechanism Phase 0 confirmed
(`.agents/friction-log/20260813171221-issue-57-phase/`), ported it to Swift,
regenerated the `teamai` golden, and re-measured the real-engine oracle. The
`windy completion % stays sane` assertion in `tools/test-ai.ts` is now green
(73.7%, was 67.1%, floor 70%) with no floor change needed.

### Diagnosis, not just the plan's hypothesis

The Phase 1 plan comment guessed the defect was `laneBlockage`'s reach-radius
shape being tuned for a chasing defender rather than a stationed one. That
turned out not to be the load-bearing mechanism. Instrumenting
`tools/test-ai.ts`'s block log with the flight-time fraction at which each
block actually landed (`fl.t / fl.tf`, comparable directly to
`laneBlockage`'s own `s.t` samples since both run 0..tf) showed the real
shape: over 227 windy blocks, 73.6% landed PAST `laneBlockage`'s `s.t > cut`
cutoff (`cut = 0.78 * tf`), and for the three zone roles built to arrive
late — wing-open, short-deep, wing-break — it was 97-100% (together 69% of
every block). Cup roles, which sit close to the mark from release, were
already inside the window 98-100% of the time.

```
227 windy blocks, by zone role, fraction of flight time at which the block landed:
  wing-open    n= 88 meanFrac=0.92 pastCut(>0.78)=86/88 (97.7%)
  short-deep   n= 60 meanFrac=0.95 pastCut(>0.78)=59/60 (98.3%)
  cup-left     n= 46 meanFrac=0.13 pastCut(>0.78)= 1/46 (2.2%)
  cup-right    n= 11 meanFrac=0.38 pastCut(>0.78)= 3/11 (27.3%)
  wing-break   n=  9 meanFrac=0.94 pastCut(>0.78)= 9/9  (100.0%)
  person       n=  8 meanFrac=0.90 pastCut(>0.78)= 7/8  (87.5%)
  cup-mark     n=  3 meanFrac=0.14 pastCut(>0.78)= 0/3  (0.0%)
  deep         n=  2 meanFrac=0.94 pastCut(>0.78)= 2/2  (100.0%)
  TOTAL past cut: 167/227 (73.6%)
```

`laneBlockage`'s `cut` was never a bug in its reach *formula* — it was a
window that excluded the last 22% of every non-mark defender's sampling on
the stated assumption that only the receiver's own man threatens that late,
and he's already priced by `separationAt`. True in person defence, false in
zone, where a help defender who is nobody's "man" (a wing/short-deep helper)
closes on the catch point in exactly that window and was priced by neither
function.

### Two failed intermediate attempts, and why

**v1 — extend the tail to every non-`onMan`/`onDisc` defender, unbounded
growth, ungated.** Fixed windy cleanly (73.7% harness, 74.8% wide pool, 73.0%
oracle) but collapsed the Swift sevens huck assertions (`the deep game
exists`: 2 attempts vs a floor of 6; `the deep-shot valuation fires`: 5 vs
6). Cause: a huck's flight time roughly doubles past `SOLVE_LOFT_RANGE`
(`LOFT_FLIGHT = 1.75`), so `cut` itself is already several seconds on a
25 m+ throw, and the reach-growth term (`v * (s.t - 0.14) * 0.72`) extended
to the true endpoint gives ANY defender near a crowded endzone a double-
digit-metre "reach" — which SATURATES the `(reachable - hd) / 1.4` clamp
(tops out at a 1.4 m excess) rather than merely discounting the throw. Every
huck looked maximally blocked to the EV model, so the offence stopped
attempting them almost entirely, not just more often declining risky ones.

Also, even before the huck problem, "extend to every non-`onMan`/`onDisc`
defender" reached too far on its own: `onMan`/`onDisc` (nearest-to-receiver,
nearest-to-aim, computed at throw-selection time) are only an approximate
stand-in for "the receiver's actual defender." In ordinary person defence,
whenever a cut has genuinely created separation — the offence working as
intended — the real defender is often neither the nearest-to-receiver nor
nearest-to-aim body, so he was misclassified as "uncovered" and got the tail
extension too. That pulled calm-day numbers down alongside the windy fix
(`completion holds across seeds` 74.2%→82.5%, `a reset handler is stationed`
88.7%→92.9%) — a real improvement in isolation, but not one the task asked
for and not verified as safe on its own, so it went in the "collateral, not
scoped" bucket.

**v2/v3/v4 — cap the growth term** (freeze chase-time at `cut`, cap at a flat
absolute time, cap the growth metres, in various combinations) while still
applying to every uncovered defender regardless of scheme. All of them
traded windy signal for huck safety somewhere on the frontier and never
cleared 70% AND kept calm-day/hucks intact simultaneously — the capping was
fighting a problem (broad person-defence misfire) upstream of where it was
applied.

### The fix that actually worked: gate the whole extension on the opponent's
### CALLED scheme, not on a per-defender coverage guess

`world.scheme[1 - team] === 'zone'` is a real, existing, cheap signal (issue
#57's earlier partial fix already threads it into `AIWorld` for exactly this
kind of use). Gating the tail extension on it — full extension, unbounded
growth, when `foeZone` is true; byte-identical to the pre-fix function when
it's false — did what none of the capping attempts did:

- `foeZone` false (person defence): the function takes the EXACT pre-fix
  code path. Calm-day completion, completion-holds-across-seeds, reset-
  handler-stationed all landed back at their exact pre-existing baseline
  numbers (78.9%, 74.2%, 88.7% — not approximately, byte-for-byte).
- `foeZone` true (zone): full unbounded extension, same as v1. The windy
  assertion's own scenario is 100% zone-live throughout (verified via the
  oracle probe below), so it loses nothing relative to v1's windy number.
- Hucks recovered because most sevens-match points are person defence
  (random weather draw, only occasionally zone), so the vast majority of
  huck attempts never touch the gated branch at all. Verified directly:
  Swift `SimTests --all` full suite, 2,160,775 assertions, 0 failures —
  `the deep game exists` (10 hucks over 3 matches, floor 6), `the deep-shot
  valuation fires`, `humancut` (37, exactly its committed floor) and
  `stoppage` (4482, exactly its committed floor) all recovered too, which
  had also regressed transiently under v1/v2 as downstream cascades of the
  same broad person-defence misfire (different RNG-consumption sequences
  from different throw choices, not independent bugs).

### Numbers (final, gated version)

- `windy completion % stays sane`: 67.1% → 73.7% pooled over 4 wind seeds
  (126/171), floor 70%. PASS, no floor change.
- Real-engine oracle, same 12-seed pinned-wind methodology as Phase 0
  (`GameSystem`'s private `wind`/`weather` fields overridden directly,
  420 s/seed, `zoneLiveFrac` 100% every seed): 65.5% (258/394) → 73.0%
  (297/407).
- `test-ai.ts` full suite: 64/70 → 65/70. The 5 remaining reds are
  byte-identical to the AGENTS.md baseline table (unrelated, pre-existing,
  not touched by this fix).
- `test-game.ts`: 149/149 both before and after, byte-identical numbers
  (this seed set barely touches zone).
- Swift `SimTests --all`: PASS, 2,160,775 assertions, 0 failures, in an
  isolated detached worktree.
- `npm test` (goldens tooling suite): 51/51.

## Why it cost time

Getting from "diagnosis" to "fix that doesn't regress anything" took four
intermediate versions because the failure modes were each invisible from a
different one of the tools being used to check them: `tools/test-ai.ts`
alone would have shipped v1 as correct (it has no huck assertion), and the
Swift `SimTests` alone wouldn't have caught the calm-day/completion-holds
regression on its own numbers as clearly as the byte-for-byte TS baseline
comparison did. Only running both, and diffing every assertion rather than
just the target one, surfaced the actual fix.

## What would help

If a future fix to `laneBlockage` or `evaluateOptions` needs the same
"is this throw against a stationed zone body" signal, `world.scheme` is
already threaded through and is the right lever — reach for it before
reaching for a coverage-proximity heuristic like `onMan`/`onDisc`, which is
a good enough proxy for `separationAt`'s own narrow late-flight purpose but
not precise enough to gate a structural change in scope on its own.
