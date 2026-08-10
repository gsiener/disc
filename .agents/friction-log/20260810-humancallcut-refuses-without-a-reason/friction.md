---
title: 'humanCallCut returns nil for five different reasons and the view has to guess which, because the only public phase is the coarse one'
severity: 'minor'
---

Found while making refused taps legible (#67), which needs exactly the fact the
engine does not report.

`Engine.humanCallCut(atX:atZ:)` returns `CalledCut?`. It refuses for five distinct
reasons — the game is over, the phase is not `livePossession`, the controlled
player is not the carrier, the call cooldown has not expired, the cone named
nobody — and `nil` for all of them. `humanDefend()` is the same shape with three.
A caller that wants to tell the player *what to fix* has to reconstruct the reason
from public state, which is what `MatchView.situationalRefusal` now does:

```swift
if match.phase != .live { return .notLive }
if match.holder != match.controlled { return .notYours }
return .tooSoon                      // by elimination, since canCallCut is false
```

That works because `Engine.canCallCut` exists and is the engine's own answer to
the three situational refusals — but only *approximately*, because
**`Engine.phase` is the coarse `GamePhase` (`setup`/`pull`/`live`/`dead`) and
`canCallCut` tests `GameState`'s fine phase.** `check` and `turnoverDead` both
fold into `.live`, so a tap during the stoppage after a call, with the disc back in
our hand, is reported to the player as TOO SOON when the true reason is that the
point is not running. Same instruction, less exact reason, and there is no way to
do better from outside the package.

Two shapes would fix it, both inside files owned elsewhere at the time
(`Play/EngineHuman.swift`, `Play/Engine.swift`):

- return a result rather than an optional — `enum CutRefusal { case notLive,
  notCarrier, cooldown, coneEmpty }`, which also gives the checks something to
  assert; or
- expose the fine phase, or a `stoppage: Bool`, so the coarse fold is not the only
  read available.

Until then the words on screen are right four times out of five refusals and the
fifth is a milder lie than silence was.
