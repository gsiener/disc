---
title: 'Control sticks to a diving player while a team-mate holds the disc, because a catch cannot outrank an unavailable body'
severity: 'minor'
---

## The trace

`tools/test-game.ts` asserts `catchControl === catchChecked` — control is on the
catcher on the catch frame. It fails intermittently, roughly one catch in eight
to one in eleven, and it moves with any gameplay change. It was written off once
as small-sample flakiness. It is not.

Instrumented, a real miss reads:

```
control miss: t=79.38 catcher=3 controlled=4 intended=4 flight=2.442s
              catcherState=jog airborne=false
```

The human threw to #4. #4 laid out for it and missed. #3 caught it. Control
stayed on #4 for the length of his dive — so the player was driving a body
face-down on the turf while a team-mate stood holding the disc under a live
stall count.

The catcher is not the problem: `catcherState=jog`, `airborne=false`, so he is
perfectly available. The block is the OTHER half of the guard in
`Game.takeControl`:

```ts
const cur = this.byId.get(this.controlledPlayerId);
if (why !== 'manual' && cur && !this.loco.isAvailable(cur.loco)) return false;
```

Control cannot move off an unavailable body, and a diving player is unavailable
for the length of the dive.

## Why it was not simply fixed

Adding `why !== 'catch'` to that guard works and immediately fails a different,
explicit assertion:

    and never moved off an unavailable body except on a manual switch

So the contract is deliberate and tested, not an oversight. Changing it is a
real design decision about whether the animation or the disc wins, and it wants
someone who knows why the invariant was written — not a drive-by edit at the end
of a long session.

## What to decide

Either:

1. A catch outranks animation integrity — control follows the disc, always.
   Then the `never moved off an unavailable body` assertion needs a documented
   `catch` exemption, and the animation break needs a look on screen.
2. The invariant stands — then `catchControl === catchChecked` is measuring
   something impossible and should assert that control reaches the catcher
   WITHIN a short window (say 0.4 s) rather than on the exact frame.

Option 2 is cheaper and probably right; option 1 is what the game arguably wants.
Either way the current pair of assertions cannot both hold.

## Reproduction

`node tools/test-game.ts` — the miss detail prints above the assertion whenever
it fires. The diagnostic (catcher, controlled, intended, flight time, catcher
loco state and airborne flag) is committed in `tools/test-game.ts`.
