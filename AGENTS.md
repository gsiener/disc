# Agent instructions

**Read [BRIEF.md](BRIEF.md) first.** It is the engineering contract for this
repository — file ownership, the zero-binary-assets rule, determinism, the
quality tiers, and which capture rig to use for what. Nothing here replaces it.

## Working alongside other agents

Several agents usually share this checkout at once, each owning a named set of
files. Two rules keep that from corrupting the history, and both were learned by
breaking it:

**1. Never run a whole-tree git command in the shared checkout.** `git add -A`,
`git commit` with no pathspec, `git stash`, `git checkout .` and `git reset` all
operate on everyone's work, and none of them has a notion of "mine". A plain
`git add X && git commit` commits **the whole index**, including whatever a peer
staged a second ago — that has put a half-finished refactor on `main` twice,
once referencing a file its author had not committed yet, which broke the build
for everyone. `git stash` is worse: it stashed three files belonging to two other
agents and then refused to pop.

Commit with an explicit pathspec instead, which ignores the rest of the index:

```sh
git commit -- path/one path/two      # or: git commit --only <paths>
```

**2. Verify a commit is self-contained before you stop.** Your working tree
contains other people's changes, so a green build there proves nothing about what
you committed. Check the commit in isolation:

```sh
git worktree add --detach /tmp/verify HEAD
cd /tmp/verify/swift && swift build -c release && .build/release/SimTests
git worktree remove --force /tmp/verify
```

A detached worktree is also the right way to measure a baseline — check out the
commit you want to compare against, rather than reaching for `git stash`.

## Friction log

Managed by [Frog](https://github.com/wevm/frog). Entries live in
`.agents/friction-log/`, one directory each, committed with the code.

- Log papercuts and friction (tooling, docs, APIs, tests, conventions) as you
  hit them with `npx frog log`.
- Do not add global, system, or internal friction.
- Run `npx frog list` first to see what is already known.

Write the entry **at the moment you hit the friction**, not at the end of the
task. This repository has already lost several hard-won findings that way — a
diagnosis that took an agent forty minutes was reconstructed twice by later
agents because it only ever existed in a report that scrolled past.

Put whatever reproduces it in that entry's `artifacts/`. On this project a
reproduction is usually a probe under `tools/_*.mjs` (gitignored by pattern, so
copy it into `artifacts/` rather than referencing it in place) or a named
capture directory under `shots/` (gitignored entirely — copy the specific PNG).

## Verifying work

Both of these matter and they catch different things:

```sh
npx tsc --noEmit        # must be clean
node tools/test-game.ts        # 109 assertions — rules, targeting, control
node tools/test-ai.ts          # 48  — off-ball structure
node tools/test-locomotion.ts  # 81  — movement model
node tools/test-move.ts        # 37  — body separation
node tools/test-anim.ts        # 83  — gait, foot contact
node tools/test-camera.ts      # 67  — broadcast camera
```

Regenerating goldens rewrites files other agents own, so **name the modules you
own**: `node --experimental-strip-types tools/gen-goldens.ts rules gamestate`
rewrites only those two. With no arguments it rewrites all sixteen — which has
already landed stale fixtures on `main`. Then run the port's own suite:
`cd swift && swift run -c release SimTests` must end `PASS` with 0 failures.

`tools/test-camera.ts` has one known failure, `wasted yaw travel p99`. That
metric is documented in the file as unstable under changes that are not the
camera's — it scored 8.65, 11.49, 11.51, 12.48 and 14.25 across five successive
states of `src/sim/AI.ts`. Do not chase it, and do not report it as yours.

And **look at the pixels**. `tools/capture.mjs` pins the camera and freezes the
world, which is right for judging a material and useless for judging anything
that moves; `tools/capture-live.mjs` releases both and photographs real play.
See BRIEF.md for the operational traps in both.

### Shut the Simulator down when you are done with it

A booted simulator is a running iOS: a dozen daemons, a live GPU context, and —
if you left the app running — a match still ticking at 120 Hz forever. Several
agents verify on device in a session and they accumulate.

```sh
xcrun simctl terminate booted <bundle-id> 2>/dev/null   # stop the app first
xcrun simctl shutdown all
osascript -e 'quit app "Simulator"' 2>/dev/null
```

Do it as the last step of your task, after your final screenshot — not between
runs, since booting again costs more than leaving it up for the next check. If
another agent is mid-verification, `shutdown all` takes their device out from
under them, so shut down **only what you booted** (`xcrun simctl shutdown <udid>`)
while peers are running.

This is not only hygiene. A simulator process once recycled a PID that a stale
`~/.gnupg` lock file named, which blocked every commit in the repository until
the daemons were killed.

The same applies to the compiler. A killed or timed-out `swift build` can orphan
`swift-frontend` processes, which are neither small nor short-lived — several
agents building in parallel worktrees can leave gigabytes resident. Check before
you finish, and only ever kill orphans:

```sh
pgrep -fl swift-frontend        # expect nothing when no build is running
```

Never blanket-kill while a peer may be building — a `swift-frontend` with a live
parent is someone's compile, and killing it produces a confusing failure in
their session rather than yours.
