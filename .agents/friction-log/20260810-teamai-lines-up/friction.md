---
title: 'TeamAI lines every body up on the goal line for any phase that is not live, so a mid-point stoppage cannot be expressed'
severity: 'major'
issue: 'gsiener/disc#49'
---

## Description

`TeamAI.update` dispatches on four AI phases and three of them go to one place:

```swift
if world.phase == .setup || world.phase == .pull || world.phase == .dead {
    return lineUp(world, dt)
}
```

`lineUp` sends **every body on the side to its own goal line**. That is correct for a
pull and wrong for every other stoppage in the sport. A timeout, a contested call and a
check all stop play with the disc where it is and the thrower on his pivot; the machine
resumes them with the same possession.

Wiring `GameState.callTimeout` (issue #20) hit this immediately. `Engine.phase` mapped
`.timeout` to `.dead`, which is the honest reading of "is play live" — and it emptied the
field: measured **83 metres of thrower drift** over one twelve-second timeout, the offence
jogging downfield with the disc while the clock was stopped, and the whole possession
teleporting on the check.

There is no fourth answer available. `.setup`, `.pull` and `.dead` all line up, and
`.live` is the only phase that leaves the bodies where they are — so a stoppage has to be
described to the AI as live play, which it then has to be prevented from acting on by
other means. It happens to work: every release path is gated on `LIVE_POSSESSION`, so a
side told the game is live during a timeout re-forms around the disc and can do nothing
else. But that is a coincidence of two unrelated guards, not a design.

## Why nothing caught it

The three phases that line up were the only three that ever occurred. `.dead` meant
`POINT_SCORED`, `HALFTIME` and `GAME_OVER` — all of which really do want a line-up, and
two of which end the point. `TIMEOUT` had no caller, so the one phase where lining up is
catastrophic had never been reached.

## Suggestion

`GamePhase` wants a fifth case — `stoppage`, or `held` — meaning "the disc is in a hand
on a spot and nobody may act". `lineUp` is then not the default for everything that is
not live, and `Engine.phase` can answer the question honestly instead of choosing the
least destructive lie.
