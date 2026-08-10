---
title: 'XCUITest: gestures are main-thread-only, and one accessibility read costs as long as a HUD plate lives'
severity: 'major'
---

Found while building the first XCUITest suite for this game (`ios/UltimateUITests`).
Three separate walls, each of which cost a full six-minute suite run to identify.
Anyone extending the touch tests will hit all three.

**1. An XCUITest gesture cannot be run off the main thread, and trying takes the
whole suite down.**

The obvious way to observe a HUD element that only exists *while a finger is
down* — the aim overlay's `CANCEL` label — is to start the gesture on a
background queue and poll the accessibility tree from the test thread, because
every gesture call blocks for its whole duration. It does not work:

```
*** Assertion failure in -[XCUIApplication _dispatchEvent:eventBuilder:], XCUIElement+Events.m:375
Must be called on the main thread. (NSInternalInconsistencyException)
```

That is an uncaught ObjC exception in the *runner*, not a test failure: the
runner process dies, xcodebuild restarts it, and the tests that had not run yet
are silently dropped from the count. The run reports "Executed 2 tests" for a
class with four. So the consequence of the mistake is a suite that looks like it
passed less than it did.

There is no public API for this. Anything that exists only under the thumb is
therefore unobservable from a UI test, and the test has to assert a lasting
consequence instead. Related: there is also no multi-waypoint drag —
`press(forDuration:thenDragTo:withVelocity:thenHoldForDuration:)` is one straight
segment — so a literal out-and-back drag cannot be driven at all.

**2. One accessibility snapshot costs a good fraction of a second, which is
comparable to how long this game's HUD plates live.**

`CutCall.duration` and `DefenceCall.duration` are both 1.1 s. Measured on an
iPhone 17 Pro simulator, one `XCUIElement.label` read against this view tree
costs roughly 0.4–0.9 s, and `waitForExistence` plus a "collecting debug
information to assist test failure triage" pass costs over a second.

So the natural test order — tap, confirm the engine took it by polling a state
probe, then look for the plate — spends the plate's entire lifetime on the
confirmation and then fails to find it. Both tap tests failed exactly that way
on their first run, with the tap having actually worked. The screen read has to
come first and the durable counter second.

**3. `xcodegen generate` plus a removed source file leaves a stale test binary in
an existing `-derivedDataPath`.**

After deleting a scratch test file and regenerating the project, a run reproduced
a failure whose cause had already been removed from the source — the background-queue
crash from (1), from a file that no longer contained it. `rm -rf` on the derived
data made it go away. Anything surprising about a UI test failure is worth
re-checking against a clean derived data directory before believing it.

**Also worth recording, since it took a probe to see it:** with no human input at
all, 3v3 minis on Normal alternates possession about every ten seconds and scored
no goals in 150 s of wall time. Every possession appears to end at or near the
stall count. The probe run that produced that is in `artifacts/_zdiag.swift` —
drop it into the UI test target and it prints one line per possession change.
