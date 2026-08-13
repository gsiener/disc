---
title: 'Issue #16''s MatchDirector interface sketch can''t compile as written — UltimateSim can''t depend on FlightUI''s Feel type'
severity: 'minor'
---

## Description

Issue #16's Phase 1 plan gives an interface sketch for the extracted
`MatchDirector`:

```swift
public struct FrameOutput {
    public let haptics: [Feel.Beat]
    public let ticksRun: Int
    public let saveRequested: Bool
}
```

`Feel.Beat` is a `FlightUI` type (`Sources/FlightUI/Feedback.swift`).
`MatchDirector` has to live in `UltimateSim` (next to `FrameClock`, per the
plan itself) so the terminal `SimChecks` harness can drive it headlessly.
`UltimateSim` depending on `FlightUI` inverts the dependency direction
ADR-0002/0008 exist to enforce, and would drag SwiftUI/RealityKit into the
`SimTests` binary — the exact thing the issue's own "alternatives considered
and rejected" section rules out for a different reason (SimChecks importing
FlightUI).

Anyone implementing the sketch literally hits this at the first `swift build`
of the real module. The fix is mechanical once you see it: `FrameOutput`
carries the raw `[MatchEvent]` instead, and the caller (`MatchView`) derives
`Feel.Beat`/`TurnoverFlash` from them — exactly what `MatchView.advance` did
inline before the extraction, so nothing about *what* gets played changes,
only where the mapping from event to feedback happens.

## Where this bit

Phase 1 of #16, writing `swift/Sources/UltimateSim/MatchDirector.swift`. Caught
before it cost a build — read the sketch, checked `Feel`'s module, adjusted
`FrameOutput` before writing the type — but it's exactly the kind of thing a
literal transcription of an approved plan walks into, and the plan itself
doesn't flag it (it flags the SimChecks-imports-FlightUI direction, not the
symmetric UltimateSim-imports-FlightUI one).

## Fix for next time

`FrameOutput`/anything crossing the `UltimateSim` → `FlightUI` boundary should
carry `UltimateSim` types only (`MatchEvent`, not `Feel.Beat`; raw ids, not
view-side wrapper structs like `Handoff`). Phase 2/3 will hit the same
question for whatever `MatchSession`/`InputScript` end up carrying — worth
checking each new field against "which module actually defines this type"
before it's added to a sketch, not after the module doesn't compile.
