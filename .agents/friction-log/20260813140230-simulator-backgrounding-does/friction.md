---
title: 'Simulator backgrounding does not reproduce issue #53''s white-screen-on-reopen'
severity: 'minor'
---

app, white screen") in the iOS Simulator before concluding the leading
hypothesis (MatchDirector.needsFrames(running:) staying false through a
scenePhase-active transition, so TimelineView(.animation(paused:)) never
unpauses and RealityView's update closure — which is what repopulates
MatchScene via sync — never re-runs).

Tried, none reproduced a blank/white screen, only ever the expected
last-rendered frame (PAUSED overlay, pre-game sheet, or the pitch itself,
all correctly drawn):
  - cold launch with -setup off
  - background via `osascript` sending Cmd+Shift+H to the Simulator app
    (genuine scenePhase transition, not an XCUITest synthetic signal),
    then `xcrun simctl launch` again to reopen
  - the same cycle on a bare pre-game sheet, before ever starting a match
  - a full `simctl terminate` + relaunch (process actually killed, not
    just backgrounded) with a resumable save on disk

The mechanism traced through the code is real and plausible (frame stops
bumping, TimelineView stays paused, RealityView has no reason to run
`update` again) but Simulator's Metal/CAMetalLayer handling across
backgrounding apparently doesn't starve the same way real hardware might
— SwiftUI's "holds the last emitted date" guarantee is about its own
timeline, not about whether the drawable backing a RealityKit view
survives being backgrounded untouched, and I could not find a way to
force or observe that gap from the Simulator side.

Shipped a low-risk fix anyway (force one unpaused frame right after
scenePhase returns to .active, consumed immediately) since it's cheap
insurance against exactly this class of bug regardless of mechanism, but
could not get a visual repro-then-fixed confirmation the way the task
asked for. If this happens again, the fix likely needs to be validated on
a real device rather than Simulator.
