---
title: 'tools/test-ai.ts''s windy completion % gate is unreachable from ThrowSolver.ts, so #32''s real acceptance criterion is a different bug'
severity: 'major'
---

## Description

Issue #32 diagnoses `src/sim/aero/ThrowSolver.ts` (and its Swift port) as wind-blind
when AIMING a throw, and names `node tools/test-ai.ts` -> `windy completion % stays
sane` as the acceptance test. The diagnosis is correct and the fix (a heading secant
that runs after bank has settled, gated on a 2 m/s crosswind deadband, reading its
error in the FIXED target frame rather than whatever heading is currently being
probed) is real: a direct probe (`tools/_wind_probe.ts`, archived at
`.agents/friction-log/20260810-throwsolver-wind-blind/artifacts/`) found the
pre-trim lateral residual reaching 37 m on a 32 m throw under a 9.5 m/s crosswind,
and the fix brings the FULL 5-type x 8-fraction x 8-heading combinatorial sweep's
p50/p90 miss under real wind back in line with the calm-day sweep (p50 0.16 m vs
0.12 m, p90 7.22 m vs 7.73 m) -- see the new third sweep added to
`tools/goldens/throwsolver.ts` / `swift/Sources/SimChecks/Goldens/throwsolver.json`.

**But `tools/test-ai.ts` cannot see any of this.** Its own docstring says exactly
what it is: "headless verification of `src/sim/AI.ts` + `src/sim/Playbook.ts`". It
never imports `Game.ts` or `ThrowSolver.ts` at all -- it has its own standalone,
wind-free ballistic flight model (`sampleFlight`, interpolating straight from the
thrower to the AI-chosen `aim` point with no wind term anywhere in it). Confirmed by
instrumenting `solveRelease` with a debug print gated on `WIND_DEBUG`: zero output
across a full `node tools/test-ai.ts` run. The fix has and can have ZERO effect on
this specific assertion, verified empirically (51.6% pooled, 79/153, byte-identical
to the pre-fix number, before and after the ThrowSolver change).

## What actually drives the 51.6%

Systematic ablation (temporary env-var branches in `AI.ts`/`Playbook.ts`, reverted
before commit) isolated the real mechanism. Turnover-cause logging showed 94% of
the pooled windy run's 71 turnovers are `block` (a defender beating the receiver to
the disc), essentially none are `ground` (the disc landing where nobody is, which is
what an aiming/drift defect would produce) -- already inconsistent with "the disc
drifts off target."

Neither `shouldPlayZone`'s wind-triggered zone defence (windSpeed > 4.5) nor
`pickScheme`'s wind-triggered upwind force-flip (windSpeed > 5) nor
`maxThrowRange`'s existing `windAlong` term, disabled individually, moved the number
out of the FAIL range (46.0%, 55.5%, 48.4% respectively -- all still red). Disabling
`Playbook.chooseFormation`'s `windSpeed > 7.5 -> 'vertical'` rule ALONE got to 65.1%
(still red). Disabling that formation rule AND `shouldPlayZone` TOGETHER passed:
72.0% (126/175), inside the 70-98% band. Zeroing `world.wind` entirely (the master
check) recovers 83.7%, confirming wind is definitely the causal input -- just not
through the function issue #32 names.

So the real, test-ai.ts-relevant defect is that the wind-triggered 'vertical'
formation call and the wind-triggered zone-defence call compound to produce far
more contested/blocked throws than either alone, or than the issue's framing
("the disc keeps going somewhere else") describes. This is a different, deeper
defect in the offensive-formation / defensive-scheme wind response, not a throw
solver problem, and not a five-minute fix -- retuning either system risks the other
calibrated behaviours (block rates, zone-trigger points, force compliance) that
other passing assertions already depend on.

## Why this is worth writing down

An issue's own diagnosis and its own cited acceptance test can point at two
DIFFERENT bugs that happen to correlate under the same environmental input (wind).
`tools/test-ai.ts`'s docstring says plainly that it does not exercise `Game.ts`; the
five minutes it takes to read that before trusting the issue's causal story would
have saved the ablation work above. Read what a test suite says it tests before
assuming a fix that reads right will move it.
