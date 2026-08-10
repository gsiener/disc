---
title: 'AGENTS.md tells every agent to verify in the same directory, and the second one clobbers the first mid-build'
severity: 'minor'
---

## Description

`AGENTS.md` gives one recipe for checking a commit in isolation, and it names a fixed path:

```sh
git worktree add --detach /tmp/verify HEAD
cd /tmp/verify/swift && swift build -c release && .build/release/SimTests
```

Several agents share this checkout and all of them read that instruction. Following it
literally, a `/tmp/verify` — or a scratchpad `verify/`, which is the same mistake with a
longer prefix — is a name two agents pick at the same time. What that looks like from
inside the losing build is not a collision message:

```
error: input file '.../verify/swift/Sources/SimChecks/BoxScoreTests.swift'
       was modified during the build
(eval):1: no such file or directory: .build/release/SimTests
```

A source file the commit under test does not touch appears to change while the compiler
reads it, the link never happens, and the run fails with exit 127 on a missing binary. The
verification worktree had by then been re-pointed at another agent's SHA — visible only in
`git worktree list`, which showed the path checked out at a commit that was not the one
handed to `git worktree add`. Cost: one release build plus one suite run, on a box where
that pair is minutes.

The scratchpad directory is shared the same way and by more agents. A generic file name in
it is not private either: a `msg.txt` written there to hold this commit's message came back
containing a peer's commit message about XCUITest gestures.

## Suggestion

Make the recipe's path unique per agent, in `AGENTS.md` itself, so nobody has to notice
this on their own:

```sh
V=$(mktemp -d)/verify        # or /tmp/verify-$(git rev-parse --abbrev-ref HEAD)
git worktree add --detach "$V" <sha>
```

And treat a shared scratchpad like the shared checkout it is: prefix files with something
that belongs to you. Also worth remembering that `git worktree list` is the cheap way to
tell "my build is broken" from "my build is somebody else's now" — it prints the SHA each
path is actually at.
