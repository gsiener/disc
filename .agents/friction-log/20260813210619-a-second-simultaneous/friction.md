---
title: 'A second simultaneous RealityView silently never composites'
severity: 'minor'
---

existing ZStack (both mounted at once — the match's RealityView stays alive
underneath, `showPractice` only drew practice on top of it) built and loaded
every mesh correctly (confirmed via `xcrun simctl spawn <udid> log show`:
"Blocking engine queue waiting for AssetLoadRequest... succeeded loading" for
every plane/box/sphere in the practice scene) but rendered nothing — the
practice pitch stayed the plain SwiftUI `.background` color, no crash, no
error dialog, no console warning from SwiftUI. The only trace is one CoreRE
log line: "IBL Blending is not supported for multiple scenes, skip
subsequent scenes." RealityKit apparently only lights one scene's IBL at a
time per process, and the second scene's frames are silently skipped rather
than rendered without IBL.

Fix: don't overlay a second RealityView in the same tree. Swap the whole
subtree instead — `Group { if showPractice { PracticeView() } else { the
match's TimelineView/RealityView } }` — so SwiftUI tears the first one down
before the second is built, and there is only ever one on screen.

If a symptom is "a RealityView I just added builds its geometry (log
confirms assets loaded) but the screen shows only the background color",
check whether another RealityView is mounted anywhere else in the current
view hierarchy before suspecting camera or entity-placement bugs — that is
where the time actually went (three separate reboot/relaunch cycles trying
to fix camera math before checking the device log).
