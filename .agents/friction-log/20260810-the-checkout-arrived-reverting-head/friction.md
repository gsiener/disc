---
title: 'A task brief said the tree was clean and no peers were running; the tree held 863 lines of uncommitted reverts and two peer commits landed mid-task, one in a file I was editing'
severity: 'major'
---

## Description

The brief for the touch-test task stated: *"Local main equals `origin/main` at `affa2ed` and the
tree is clean."* It was not. `git status --short` at the first command of the session:

```
D  .agents/friction-log/20260810-humancallcut-refuses-without-a-reason/friction.md
D  .agents/friction-log/20260810-the-pitch-is-not-the-window/friction.md
D  ios/UltimateUITests/RefusalTests.swift
M  ios/UltimateUITests/TouchTests.swift
M  swift/Sources/FlightUI/Feedback.swift
M  swift/Sources/FlightUI/MatchHUD.swift
M  swift/Sources/FlightUI/MatchProbe.swift
M  swift/Sources/FlightUI/MatchView.swift
```

`git diff HEAD --stat` — **8 files, 30 insertions, 863 deletions**, all of it staged or
unstaged *reversal* of what `affa2ed` and its parents had added. `RefusalTests.swift` (291
lines, four of the eleven tests the task was about) was staged for deletion. `MatchProbe` had
lost fields the surviving tests read.

The patch is in `artifacts/preexisting-revert.patch`.

## Why it matters more than a dirty tree usually does

Every local verification would have been a lie in the safe direction and the dangerous one at
once. Building and running the suite in that tree runs *nine* tests against a probe missing
fields, and a commit made with `git commit -m … -- <my paths>` would have been clean while the
green run behind it was not the code being committed. It is the same failure the repo already
has a commit for — `b3a7d10 "Restore the harness I reverted, and stop CI lying about it"` — so
this is the second time a stale tree has reverted this exact harness.

## Fix

Restored the eight paths to `HEAD` explicitly, never `git checkout .`:

```sh
git restore --source=HEAD --staged --worktree -- <the eight paths>
```

and saved `git diff HEAD` to a patch first, because discarding somebody's work on the strength
of a brief that was already wrong about the tree is not a decision to make irreversibly.

## And the brief was wrong about the other half too

The same brief said *"no other agent is running."* Two commits landed on `main` during the
session — `ea6ab4f` and `2e38164` — the second of them editing `.github/workflows/ci.yml`, a
file this task was also editing. That was caught only because `git log` was re-read halfway
through, on an unrelated hunch; the edits happened to merge, and a bare `git commit` would have
published a peer's half-finished work exactly as `AGENTS.md` describes.

So the restore above was a judgement made with bad information: the deletions could in principle
have been a peer mid-change rather than a stale tree. What made it defensible was that every
deleted line was *committed content in `HEAD`* that no commit had removed, and that the patch
was saved first. It is not a call to make casually in this checkout.

## Suggestion

**Run `git status --short` and `git diff HEAD --stat` as the first command of every task, and
`git rev-parse HEAD` again before committing** — before believing any statement in the brief
about the state of the tree or about who else is working. A brief is written before the session;
the tree and `main` both move during it. The tell for a stale tree is cheap and unmistakable: a
diff that is almost entirely deletions of content still present in `HEAD` is a revert nobody
committed, not work in progress.
