---
title: 'A thrower still drifts 2.3 m from his pivot in a limit cycle nobody has explained'
severity: 'major'
---

`humanDesired` now anchors the thrower to `gs.pivot`: outside `PIVOT_R` (0.75 m)
the outward component of the stick is stripped and an inward pull ramps with the
excess. Settled drift fell 5.47 m to 2.32 m. It should fall to ~0.75 m.

A trace shows the inward pull genuinely working and then losing:

```
t=21.0 held=1.5s r=2.17 pos=(17.0,-12.4) pivot=(17.1,-10.2) spd=1.26
t=21.3 held=1.8s r=1.85 ...
t=21.5 held=2.0s r=1.54 ...
t=21.8 held=2.3s r=1.23 ...
t=33.0 held=1.7s r=2.03 ...   <-- pushed back out
```

`r` converges monotonically, then the body is back at ~2 m and reels in again.
A limit cycle against something driving it outward.

## Ruled out

- **The stick.** At `r > 2` the pull ramp is saturated, so the commanded
  direction is fully inward with effort 0.34.
- **The soft separation tier.** Added `LocoPlayer.anchored` (compliance 0 for a
  thrower on his pivot, so a crowding marker steps around him rather than
  displacing him — correct by the rules either way) and the numbers were
  **byte-identical**: 2.32 / 3.63 before and after.
- **A moving pivot.** The trace shows `pivot` fixed at (17.1, −10.2) for 47 s.

## Suspects not yet checked

`keepOnField()` and `resolveCollisions()` both run AFTER `loco.step`, so either
could displace the body outside the steering path. The facing/aim branch in
`humanDesired` also writes `d.face` and may interact with how `Locomotion`
resolves a direction it cannot turn to.

## Impact

`tools/test-game.ts` asserts settled drift <= 2.5 m purely as a regression guard
on the improvement. The real target is PIVOT_R + a step, about 1.2 m. Until this
is found, a thrower can still slide a couple of metres, which is a rules
violation the sport takes seriously.
