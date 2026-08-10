# ADR-0005 — CI never cancels in-progress runs on `main`

- **Status:** Accepted
- **Date:** 2026-08-10 (see `.github/workflows/ci.yml:12-24`)

## Context

`concurrency.cancel-in-progress` was `true` unconditionally. In a repository several agents
push to, that is worse than it sounds.

A broken commit followed a minute later by a good one has its run **cancelled and never
reported**. `main` then looks green at a commit that does not build — which is precisely how
a broken `main` went unnoticed here. It also mis-notifies: GitHub renders a cancelled run as
*"CI: All jobs have failed"*, so every rapid second push raises a false alarm.

## Decision

```yaml
concurrency:
  group: >-
    ci-${{ github.event_name == 'pull_request' && github.ref
    || github.event_name == 'push' && github.sha
    || github.run_id }}
  cancel-in-progress: true
```

Supersede on a pull request, where only the tip matters. **Never on `main`**, where every
commit is already merged and each one deserves its own verdict.

**The group does the work, not `cancel-in-progress`.** On a push the key is the commit, so
every commit gets a group of its own and nothing can supersede it. A manual re-run keys on
the run instead, so it cannot cancel the push run at the same commit. Only a pull request
falls through to the ref, where a new push does supersede the old run — which is the intent.

### Rejected spelling

```yaml
cancel-in-progress: ${{ github.event_name == 'pull_request' }}     # does not work
```

GitHub treats **any non-empty string** as true here, and a push evaluates that expression to
the string `"false"`. Written this way the rule above reads correctly and does the opposite:
run 31390307688 (commit `17ae87d`) was cancelled two minutes in when the next commit landed.
Do not reintroduce it — put the condition in the group key, where it is a string comparison
rather than a truthiness test.

## Consequences

More runner minutes on `main` during a burst of pushes. That is the price of every commit
having a recorded verdict, and it is worth it.

## A companion rule, learned the same day

**A masked job is worse than a red one, because a red job gets fixed and a green lie does
not.**

`continue-on-error: true` was added to the touch-test job at the same time as a timeout
increase. The next run went green — and the tests had not run at all, because the suite no
longer *compiled*: a stale file had reverted another change's additions. A masked step
reported a compile error as success.

If a job is genuinely too slow or too flaky for the runner, the answer is to say so in the
workflow and skip it **deliberately** — not to let it pass while failing.

There is now **no `continue-on-error` step in the file at all.** The one exception used to be
`Warm the app`, on the grounds that it asserted nothing and so had no verdict to mask. That
argument was sound and the step was still deleted: it slept a fixed 20 s to warm a launch that
`MatchDriver.init` already performs and waits on properly, and — being masked — it could not
report that it had drifted to launch arguments the tests no longer used.

## Related, and also load-bearing

Two more rules for a repository with concurrent agents, recorded in `AGENTS.md` because both
have already caused a broken `main`:

- **Never a bare `git commit`.** Commit with explicit paths — `git commit -m "..." -- <paths>`
  — or you will commit a peer's half-finished work. This has happened twice, once producing a
  commit that referenced a file nobody had committed.
- **Push the SHA you verified, not the branch.** `git push origin <sha>:main`. Pushing a
  moving branch tip publishes whatever landed after you looked.
