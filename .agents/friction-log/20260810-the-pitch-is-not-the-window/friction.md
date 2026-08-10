---
title: 'The pitch is 750x338 at (62,0) of an 874x402 window, so every UI-test tap expressed as a window fraction was aiming somewhere else'
severity: 'major'
---

Found while making refused taps legible (#67), by adding the render surface's own
frame to the UI-test probe and printing it.

`ios/UltimateUITests` aims its taps with
`app.coordinate(withNormalizedOffset:)`, which is a fraction of **the window**.
The game is not the window. Measured on an iPhone 17 Pro simulator in landscape,
`MatchView`'s `GeometryReader` reports:

```
PLAYABLE RECT: pitch (62.0, 0.0, 750.0, 338.0) of window (0.0, 0.0, 874.0, 402.0)
               insets l62 t0 r62 b64
```

So in a **debug** build the pitch is inset 62 pt on each side — the display cutout
— and 64 pt at the bottom, which is the instruments `TabView`.
`pitchPoint(0.5, 0.5)` and `point(0.5, 0.5)` are 30 pt apart vertically and the
error grows toward the edges: a tap meant for the near sideline at x = 0.08 lands
9% of the pitch off, which at this camera is several degrees of heading — and the
heading *is* the input, since `Engine.humanCallCut` reads only the direction from
the thrower.

Worse, the error is **different in the configuration that ships**, and not in the
way anyone assumed. A release build has `showsInstruments == false` and no
`TabView`, and it is *not* the whole window either — measured:

```
debug:   pitch (62.0, 0.0, 750.0, 338.0)   insets l62 t0 r62 b64
release: pitch (62.0, 0.0, 750.0, 382.0)   insets l62 t0 r62 b20
```

The tab bar costs 44 pt of pitch height; the remaining 20 pt is the home
indicator, and the 62 pt a side is the device in both. So a tap fraction tuned by
hand in Debug is a different piece of grass in Release, and the touch tests were
verifying a rectangle no player gets. The first version of the assertion in
`testThePitchIsTheRectangleTheTapsAssume` said Release *was* the window, and the
first Release run of it is what corrected that.

The fix is cheap and it is in place: the probe reports
`rect=x,y,w,h` from `geo.frame(in: .global)`, `MatchDriver.pitchPoint` maps
fractions through it, and `RefusalTests.testThePitchIsTheRectangleTheTapsAssume`
prints both rectangles and asserts the one edge the configuration decides — a
strip bigger than a home indicator under the pitch in Debug, and nothing but the
home indicator in Release. Run the suite both ways:

```sh
xcodebuild test -project Ultimate.xcodeproj -scheme UltimateUITests -destination '...'
xcodebuild test -project Ultimate.xcodeproj -scheme UltimateUITests -destination '...' -configuration Release
```

**Two related traps, both paid for once here.** The scoreboard is the one piece of
HUD that takes touches (a `.background` shape is hit-testable), it is pinned 12 pt
down and full width bar a 16 pt margin, and the sky — everything above the horizon,
which `MatchScene.groundPoint` refuses — is only about 50 pt tall. So the only
piece of sky a finger can reach is the far left of that strip: a tap on the sky at
x = 0.5 never reaches the game. And `-cut x,y` takes fractions of the *pitch*
already, because it multiplies by `viewSize`, so its coordinates and a UI test's
window fractions were never the same coordinates.
