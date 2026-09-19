---
title: 'SimTests takes a suite filter, but AGENTS.md only documents full runs'
severity: 'minor'
---

swift run SimTests shape runs one suite (see swift/Sources/SimTests/main.swift). AGENTS.md verifying-work lists only full-suite commands, so I planned a temporary executable target plus a Package.swift edit to diagnose a shape failure before finding the filter. It composes with --all and --show.
