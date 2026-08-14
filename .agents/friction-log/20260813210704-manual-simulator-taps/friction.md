---
title: 'Manual Simulator taps: losing frontmost focus silently no-ops the click'
severity: 'minor'
---

Events window bounds + `cliclick`) instead of XCUITest, to poke at a new
SwiftUI button reachable only by a real tap. Cost roughly fifteen
failed-click round trips (each one a screenshot + Read-tool inspection)
before finding the actual cause.

Two compounding traps, both silent — neither errors, both just do nothing
visible:

1. **The Simulator losing "frontmost" mid-session no-ops the next click.**
   Any tool call between an `osascript activate` and a `cliclick c:x,y` can
   steal focus back (in this session, apparently other tool invocations did).
   The first click on an unfocused macOS window only focuses it; it does not
   deliver the click through to the app. `osascript -e 'tell application
   "System Events" to get frontmost of application process "Simulator"'`
   right before clicking would have caught this in one round trip instead of
   many. Now: activate Simulator immediately before every click, not once at
   the start of a sequence.

2. **The simulated device's orientation state is not stable across
   reboots/relaunches, and it silently changes which coordinate space
   clicks and screenshots use.** `xcrun simctl io <udid> screenshot` returns
   raw hardware-panel pixels — sometimes portrait (1206×2622 for this
   device) with the landscape-only app's UI drawn rotated inside it,
   sometimes already landscape (2622×1206), depending on internal
   orientation state that a plain `xcrun simctl boot` does not pin. A
   coordinate mapping calibrated against one orientation (e.g. "click at
   device-point (x,y) = window-origin + (x,y)") silently aims at the wrong
   thing after any reboot/relaunch that flips it — no error, the click just
   lands on nothing (or the wrong button) and the screen looks unchanged.

Given both traps, hand-rolled Simulator tapping (`cliclick` + screenshot
pixel-math) is not a reliable substitute for `XCUITest`
(`app.coordinate(withNormalizedOffset:)`), which resolves through the
app's own interface-orientation transform and needs none of this — see
`ios/UltimateUITests/MatchDriver.swift`'s `pitchPoint`/`point` helpers,
which already exist for exactly this reason. Next time a UI needs poking
that isn't covered by an existing UI test, write (or extend) a small
XCUITest rather than reaching for `cliclick`.
