---
title: 'AI.predictCatchPoint aimed at a height Game.tryCatch will not award a catch at'
severity: 'major'
---

## Description

`predictCatchPoint` in `src/sim/AI.ts` picked the rendezvous with a disc in flight like this:

```ts
if (s.y <= 1.45 && path[i - 1].y > 1.45) return s;   // descending through chest height
if (s.y <= 0.12) return s;                            // ...otherwise, the turf
```

The first branch needs the disc to have been ABOVE 1.45 m on the previous sample. Throws in this game release at ~1.35 m and a flat forehand never rises past it, so for the great majority of throws that branch never fires and the rendezvous falls through to the second: **the point where the disc hits the ground.**

`Game.ts` `tryCatch` refuses a standing catch below `lp.groundY + 0.20` and only lowers that floor to 0.02 for a body that is already prone. So the AI was sending receivers to meet the disc at a height where the only legal catch is a layout.

## How it showed up

As "too many layouts". Measured over 50 sim-minutes: 80% of all bids were for a disc whose predicted catch point was under 0.2 m, and the offence laid out 4.5 times a minute. Disabling bids entirely dropped completions from 115 to 89 — the dives were load-bearing, because the receiver had been sent somewhere he could not legally catch standing.

Nothing about the symptom points at the cause. The bid gate looks wrong (it was also wrong), the throw lead looks wrong, the arrival braking looks wrong. The 0.12 in a scan loop two hundred lines away does not.

## What would help

The catch height band is Game.ts's to define and every consumer has to agree with it. A shared constant, or at minimum a comment at each end naming the other. A cheap assertion would also have caught it: `predictCatchPoint().y` should essentially never be below the height the rules engine will pay a standing catch out at.
