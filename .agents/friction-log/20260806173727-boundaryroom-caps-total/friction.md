---
title: 'boundaryRoom caps TOTAL speed, so a body standing on the sideline is frozen in every direction'
severity: 'blocker'
---

## Description

`boundaryRoom(px, pz, dx, dz)` in `src/sim/AI.ts` returns the ray parameter at which a direction leaves the playable box, and `intent()` uses it as `desiredSpeed <= sqrt(2 * decel * room)` so nobody can carry momentum over a line.

The cap is on the SCALAR speed, but the room is measured along the whole ray. A player standing exactly on the limit (`FIELD.halfWidth - 0.55`) and aimed at anything with even a sliver of outward x gets `room = 0 / |ux| = 0`, so his speed is capped to zero — including the 99% of his intended direction that runs safely along the line.

## How it deadlocks the match

The disc-on-the-ground branch was the only target in AI.ts not clamped inside the lines: it sent the collector at `disc.pos` directly. Turnovers routinely leave the disc on the chalk at `|x| = 18.50`. The collector runs out to `x = -17.95`, wants to go `(-0.55, -3.87)` — 99% along the sideline — reads zero room, and stops. Forever.

Reproduced with `tools/_deadprobe.ts`:

```
t=253.77 phase=TURNOVER_DEAD 3.01s  disc=(-18.50,0.01,23.39)  nearest #3 @(-17.95,27.26) 3.91m state=idle v=0.00
t=300.01 phase=TURNOVER_DEAD 49.24s  disc=(-18.50,0.01,23.39)  nearest #3 @(-17.95,27.26) 3.91m state=idle v=0.00
```

`tools/_deadlock.ts 12 400` wedged 1 of 12 seeds before this was found (87% of one 400 s run spent dead, score 0-0). `Game.ts` already carries a mitigation for the symptom — `PICKUP_DWELL_RADIUS = 3.6` after 1.4 s, commented "parks the collector a metre short of a disc sitting on the chalk" — but the collector stops 4-6 m out, well outside it.

## Fix applied

Clamp the pickup target inside the field (`clampToField(disc.pos, 0.75)`), which is still inside `PICKUP_RADIUS = 1.6` of a disc on the line. `tools/_deadlock.ts 12 400` now wedges 0 of 12.

## What would still help

The cap itself is wrong in general, not just for pickups. Any target that puts a sliver of outward component into the direction while a player is on the limit freezes him. A per-axis cap (`vx <= sqrt(2a * roomX)`, `vz <= sqrt(2a * roomZ)`) would express the actual constraint; a scalar cap cannot. A `tools/_deadlock.ts` run belongs in the standard verification list too — `test-game.ts` only samples one seed and missed this for however long it has been there.
