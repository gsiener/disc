---
title: 'swift build -c release cannot verify your own work while a peer is mid-edit in another target'
severity: 'minor'
---

## Description

`cd swift && swift build -c release` builds every product in the package. While
another agent was mid-edit in `Sources/FlightUI/MatchScene.swift`, that target
failed to compile, and the whole build failed — so `SimTests`, which does not
depend on `FlightUI` at all, could not be built or run.

The verification recipe in AGENTS.md (`swift run -c release SimTests`) has the
same problem: `swift run` builds the package first.

This is the Swift twin of the already-logged
`20260805192110-npx-tsc-noemit` ("npx tsc --noEmit cannot verify your own work
while peers are mid-edit"), and it bites harder because the Swift build is
minutes rather than seconds, so you find out late.

## Reproduction

With any compile error in `swift/Sources/FlightUI/`:

```
cd swift && swift build -c release      # fails, in a target SimTests does not use
cd swift && swift build -c release --product SimTests   # succeeds
```

## Workaround

Name the product:

```
cd swift && swift build -c release --product SimTests && .build/release/SimTests
```

## Suggestion

If the sim agents' verification step were documented as `--product SimTests`
rather than a whole-package `swift run`, a peer's unrelated UI edit would stop
blocking sim verification entirely.
