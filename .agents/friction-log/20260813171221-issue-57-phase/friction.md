---
title: 'Issue #57 Phase 0: mechanism (1) ruled out, (2) real but confounded with (3), real-engine oracle measured at 65.5%'
severity: 'major'
---

## Description

Issue #57 Phase 0 (attribution only, no fix): the `windy completion % stays sane`
assertion sits at 67.1% pooled / ~63% wide-sample against a 70% floor. Three
candidate mechanisms were named in the issue's plan comment and confounded.
This entry records the diagnostic measurements that separate them, all
gathered via temporary instrumentation reverted before this entry was
written — nothing in this session's `git diff` touches `laneBlockage`, the
harness's block-resolution logic, or the 70% band itself.

### Mechanism (1) — harness auto-block vs. probabilistic catch: RULED OUT

Two independent measurements agree.

- **Direct probe.** Replaced `tools/test-ai.ts`'s automatic-block-on-margin
  (line ~1112) with a probabilistic contest mirroring `catchProbability` at
  the same difficulty computation the receiver's own catch already pays,
  behind a temporary `AI57_PROB_BLOCK` env flag. Wide 16-seed pool:
  **62.9% (347/552) baseline → 63.8% (360/564) under the probe** — flat, not
  the ≥72% the issue's plan set as the mechanism-(1)-dominant threshold.
- **Real engine, independently.** `Game.ts`/`GameSystem` has its own catch/
  block resolution, entirely separate from `tools/test-ai.ts`'s harness code
  — it does not share this specific asymmetry at all. If mechanism (1) were
  dominant, the real engine should land well above the harness. It doesn't
  (see the oracle measurement below): both land in the same ~65% band.

### Mechanism (2) — `laneBlockage` prices a chasing defender, not a stationed one: REAL, well-evidenced, but not cleanly separable from (3) here

Instrumented `evaluateOptions`/`release()` in `src/sim/AI.ts` (temporary
`blockage` field on the `throw` `PlayerAction`, populated from
`ThrowOption.blockage` — the actual EV-model value at the moment the throw
was *selected*, not recomputed after the fact) and logged it per block in
the wide 16-seed pool, together with `zoneRoleOf` telemetry:

```
234 blocked throws, by zone role (blockage priced AT SELECTION):
  person     n=  8  avgBlockage=0.000  lowBlockage(<0.2)=8/8   (100.0%)
  wing-open  n= 80  avgBlockage=0.001  lowBlockage(<0.2)=80/80 (100.0%)
  cup-right  n= 15  avgBlockage=0.050  lowBlockage(<0.2)=12/15 (80.0%)
  short-deep n= 62  avgBlockage=0.009  lowBlockage(<0.2)=62/62 (100.0%)
  cup-left   n= 55  avgBlockage=0.006  lowBlockage(<0.2)=54/55 (98.2%)
  wing-break n=  6  avgBlockage=0.000  lowBlockage(<0.2)=6/6   (100.0%)
  cup-mark   n=  8  avgBlockage=0.000  lowBlockage(<0.2)=8/8   (100.0%)
  TOTAL      n=234  lowBlockage(<0.2)=230/234 (98.3%)
```

98.3% of blocked throws were priced at blockage < 0.2 by `evaluateOptions`
at selection time — the offence is not gambling on throws it knows are
risky, it is throwing through defenders it prices as essentially not there.
96.6% of the blocks (226/234) came from zone roles, not person marks — this
is specifically the stationed-cup-body blindness the issue's plan named.

The caveat: `laneBlockage` lives in `src/sim/AI.ts`, which is code shared by
*both* the standalone harness and the real engine (both route offensive
throw selection through the same `evaluateOptions`). So this mechanism, if
real, would suppress completion in **both** measurements equally — it is not
something the real-engine oracle below can rule in or out on its own. It's
a well-evidenced, cheap, additive Phase-1 candidate; it just isn't cleanly
separable from mechanism (3) by measurement alone, only by trying the fix
and re-measuring both harness and oracle afterward.

### Mechanism (3) — the 70% floor predates a measured oracle: SUPPORTED

**Real-engine oracle, methodology.** `Game.ts`/`GameSystem` doesn't expose a
weather-pin option the way Swift's `EngineConfig.fixedWind` does
(`swift/Sources/UltimateSim/Play/EngineConfig.swift:75`, used by
`StoppageTests.swift`'s `theZoneIsReachableFromTheWeather`), so the TS side
was pinned by overriding `GameSystem`'s private `wind`/`weather` fields
directly after `init()` (same private-field-reach pattern
`tools/test-game.ts` already uses via `(g as unknown as {...})` for its own
diagnostics), re-applied every frame. Wind vector: `{x:9.5, z:2.0}`
(magnitude ~9.7 m/s) — the same vector `tools/test-ai.ts`'s own windy run
uses, for direct comparability. 12 seeds
(`20260729,77777,54321,12345,33333,99999,111111..666666`), 420s each at the
engine's real 1/120s step, `gs.teams[x].attempts/completions` pooled (the
same convention `tools/test-game.ts`'s `SWEEP_SEEDS` loop already uses).
Verified the pin actually produced a zone-heavy match throughout, not merely
a windy one: fraction of `LIVE_POSSESSION` frames where either team's
`world.scheme === 'zone'` was **100% on every seed**.

```
seed 20260729  att=32  comp=26  81.3%
seed 77777     att=34  comp=26  76.5%
seed 54321     att=31  comp=18  58.1%
seed 12345     att=30  comp=22  73.3%
seed 33333     att=32  comp=22  68.8%
seed 99999     att=33  comp=18  54.5%
seed 111111    att=33  comp=18  54.5%
seed 222222    att=36  comp=23  63.9%
seed 333333    att=32  comp=18  56.3%
seed 444444    att=34  comp=25  73.5%
seed 555555    att=32  comp=20  62.5%
seed 666666    att=35  comp=22  62.9%
pooled: 258/394 = 65.5%
```

65.5% pooled over 394 throws, 12 seeds — right next to the harness's own
62.9% (wide) / 67.1% (4-seed assertion), **not** the 75-80% that would have
indicted the harness's own block model as the dominant cause (the plan's own
decision rule). The 70% floor was set before zone was arithmetically
reachable under wind at all (pre-#20); this is the first time it's been
checked against a real-engine measurement, and the honest current answer —
contaminated by mechanism (2), see above — is short of it.

## Why it cost time

Getting the real-engine oracle required a pinning mechanism the TS engine
doesn't have (unlike Swift's `EngineConfig.fixedWind`); reaching it meant
overriding `GameSystem`'s private `wind`/`weather` fields from outside via a
type-cast, matching a pattern (`(g as unknown as {...})`) `tools/test-game.ts`
already uses for its own private-state diagnostics rather than inventing a
new one.

## What would help

If Phase 1 or a later task needs a real-engine pinned-wind oracle again,
`GameSystem` genuinely has no supported way to do this — a `fixedWind`-style
config option (mirroring Swift's `EngineConfig`) would remove the
private-field reach-around this entry needed. Also worth flagging for
whoever writes Phase 1: mechanism (2)'s fix and the mechanism (3) floor
re-derivation are not independent — fix (2) first, since it moves both the
harness *and* the oracle (they share `AI.ts`), then re-measure the oracle
before deciding how much of the remaining gap the floor should absorb.
