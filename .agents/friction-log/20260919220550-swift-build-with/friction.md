---
title: 'swift build with two --product flags rebuilds neither'
severity: 'minor'
---

swift build -c release --product SimTests --product SourceChecks reports 'Build complete!' in 0.3s with a dirty SimChecks file on disk and updates neither binary (mtimes unchanged). Single-product commands rebuild normally. Cost: ~15 minutes believing a green run that was executing a stale binary — the suite passed with the OLD Harness floor while the file on disk said the new one. Repro: touch swift/Sources/SimChecks/ConstantsTests.swift, run the dual-product build, stat swift/.build/release/SimTests. Workaround: one --product per invocation.
