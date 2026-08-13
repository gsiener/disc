---
title: 'xcodebuild for iOS Simulator leaves multiple stale DerivedData/Ultimate-* dirs; find | head -1 grabs the wrong one'
severity: 'minor'
---

## Description

Verifying an `ios/Ultimate/UltimateApp.swift` + `swift/Sources/FlightUI/MatchView.swift` change
(issue #54) needed a fresh Simulator install. After `xcodegen generate && xcodebuild ... build`,
locating the built `.app` with:

    find /Users/.../DerivedData/Ultimate-* -name "Ultimate.app" -path "*Debug-iphonesimulator*" | head -1

silently returned a build from **four days earlier** (`Ultimate-hkpgceqdqtkcqhdzgfeagxvklxfk`,
dated Aug 9), not the one `xcodebuild` had just produced. There were seven different
`Ultimate-*` DerivedData UUIDs on disk, apparently one per xcodegen/xcodebuild invocation
across sessions/agents, and `find`'s output order is not sorted by mtime — so `head -1` is a
coin flip. I installed and ran the stale build, saw the bug I was trying to fix ("still there"),
and nearly reported a false negative before noticing the binary's file mtime predated my own edit.

## Fix that worked

Sort candidates by mtime and take the newest:

    find /Users/.../DerivedData/Ultimate-* -maxdepth 5 -name "Ultimate.app" \
      -path "*Debug-iphonesimulator*" -exec stat -f "%m %N" {} \; | sort -rn | head -1

## Suggested fix

Either have the verification recipe in README.md/AGENTS.md call out sorting by mtime
explicitly, or `xcrun simctl install` a `.xcarchive`/fixed output path so there's only ever
one candidate. Worth a line near the `xcodebuild ... build` recipe in README.md.
