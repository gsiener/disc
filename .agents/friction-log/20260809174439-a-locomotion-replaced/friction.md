---
title: 'A Locomotion replaced at each point silently drops its LocoHost, and nothing in the suite notices'
severity: 'major'
---

## Description

`Locomotion.attach(LocoHost)` stores the host **on the instance**. `Engine.stagePoint()`
does `loco = Locomotion()` once a point (deliberately — it is how per-point stamina
restoration was implemented), which throws the host away. The single `attach` in
`Engine.init` therefore survived exactly zero ticks: `stagePoint()` is called on the very
next line to open the first point.

The consequence was #55. `Engine.policeCatch` reads `lastContact`, which is fed only by
`LocoEvent.contact` through that host. `lastContact` was empty for entire matches, so the
receiving foul and the strip were not rare in the Swift port — they were **unreachable**,
and had been since the feature landed. `catchContactCall` itself is differed bit-exact
against the reference and was green throughout.

Measured before the fix, over three full 7v7 matches: `policeCatch` reached its contact
test 21 times and found a hit 0 times. After re-attaching in `stagePoint`, strips fire 4
times over 11 matches against the reference's 3.

## Why nothing caught it

`attach` returns nothing and has no "is anybody listening" side. A model with no host is
a valid model. So a severed event stream is indistinguishable from a quiet one, and every
component fixture stayed green.

## Suggestion

Either make the host survive the instance (hold it on a small owner object the Engine
keeps, and hand it to each new `Locomotion`), or have `Locomotion` refuse to emit
silently — e.g. an explicit `detach()` so that "no host" is a state somebody chose. As
long as re-attaching is a line a human has to remember, the next `loco = Locomotion()`
will drop it again.

The general shape is the one worth recording: **`x = Thing()` that silently resets
wiring set up elsewhere.** A grep for other `= Locomotion()` / re-assigned subsystems is
probably worth someone's half hour.
