---
title: 'buildSim with no cfg argument confounds formation/force/aggression with whichever team index calls it, and issue #36''s AB test hit exactly that'
severity: 'major'
---

Issue #36 ("elite roster loses to weak roster") named two live hypotheses:
(1) the AI doesn't really consult ratings where it matters, (2) a confound
in `tools/test-ai.ts`'s `buildSim` call pairs a formation/force/aggression
with a rating rather than isolating rating alone. Both turned out true and
independently measurable.

`buildSim(seed, wind)` with no third argument — exactly how the `ratings
change on-field outcomes` AB test calls it — hands team0 (always the elite
roster in that test) `{formation:'vertical', force:'forehand',
aggression:1.05}` and team1 (always weak) `{formation:'horizontal',
force:'backhand', aggression:0.95}`. Those are `buildSim`'s own per-team-index
defaults, chosen for nothing about this test.

Measured by holding rating EQUAL (72 vs 72, all else default) and varying only
which side got which config: `vertical/forehand/1.05` loses to
`horizontal/backhand/0.95` regardless of which physical team (0 or 1) is
carrying it — 5-17 one way, 13-7 the other when swapped. Equal-rated rosters
under the DEFAULT (confounded) pairing score 4-20, a bigger spread than the
90-vs-52 rating gap the test claims to isolate. Formation alone (holding force
and aggression fixed) accounts for most of it: vertical-vs-horizontal at equal
rating and matched force/aggression still runs 5-17 to 8-13 depending on which
side is which.

Fixing the confound (matched cfg, only rating varies) moves yards/possession
into the correct direction on its own but is NOT sufficient by itself — with
matched config, elite (90) still loses on points and turnover rate to weak
(52). That's the second, independent mechanism (accuracy inflating
`pThrow`/`ev` enough that a redump clears the `hold` bar it has no business
clearing — see the sibling friction entry on the EV fix and its Swift replay
fallout). Both fixes were needed together to get `ratings change on-field
outcomes` to a real PASS.

## Impact

Anyone re-measuring "does rating X change outcome Y" with `buildSim` and no
third argument is comparing two rosters running different systems, not two
rosters at different skill. The two current callers that do this
(`tools/test-ai.ts`'s AB block, now fixed to pass an explicit `abCfg`, and the
sibling "shape" run at `tools/test-ai.ts:1624` which deliberately wants the
vertical-shipping-config comparison and is unaffected) are the only current
callers; a new one should pass an explicit, matched `cfg` if the point is to
isolate rating.

## Reproduction

In a scratch copy of `tools/test-ai.ts`, call `buildSim(seed, wind, [cfgA,
cfgB])` with `overall` held equal on both teams and swap which side gets
`{formation:'vertical', force:'forehand', aggression:1.05}` vs
`{formation:'horizontal', force:'backhand', aggression:0.95}` — the side
carrying the horizontal/backhand/0.95 config wins regardless of team index or
rating.

## Suggested fix

Done: `tools/test-ai.ts`'s AB block now passes an explicit `abCfg` — the same
`{formation:'vertical', force:'forehand', aggression:1.0, zoneBias:-0.15}` on
both sides — so rating is the only variable left. `buildSim`'s own
per-team-index defaults are untouched (they're a legitimate, deliberate
asymmetry for the tests that want it, like the shape run), which is why this
was a one-caller fix, not a `buildSim` signature change.
