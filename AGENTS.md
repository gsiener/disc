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
W=$(mktemp -d)/verify                 # a path no peer can also pick
git worktree add --detach "$W" HEAD
cd "$W/swift" && swift build -c release && .build/release/SimTests
git worktree remove --force "$W"
```

**The unique path is the point, not a nicety.** This recipe used to name a fixed
`/tmp/verify`, and every agent reads this file — so two agents verifying at once
raced for the same directory. The loser sees
`input file <SomeFile>.swift was modified during the build` on a file its commit
does not touch, followed by exit 127, which reads as a broken commit and is a
peer re-pointing the path mid-build. That cost one agent a full build plus a
suite run. The session scratchpad has the same property: a `msg.txt` written
there came back holding a different agent's commit message. Name files uniquely
or keep them inside your own worktree.

A detached worktree is also the right way to measure a baseline — check out the
commit you want to compare against, rather than reaching for `git stash`.

**3. Push the SHA you verified, not the branch.** This one is for whoever
integrates. `git push` publishes wherever `main` points *now*, which in a shared
checkout is not where it pointed when you started verifying — peers commit while
you build. That is how a red commit reached `main` here: a commit was verified,
two more landed during the twelve minutes the suite took, and `git push` sent all
three.

```sh
git push origin <verified-sha>:main    # not `git push`
```

There is no force-push escape hatch afterwards, so the only cheap moment to get
this right is before the push. If `main` does go red, fix it forward — a revert
is a commit like any other.

## Friction log

Managed by [Frog](https://github.com/wevm/frog). Entries live in
`.agents/friction-log/`, one directory each, committed with the code.

- Log papercuts and friction (tooling, docs, APIs, tests, conventions) as you
  hit them with `npx frog log`.
- Do not add global, system, or internal friction.
- **Read [`.agents/friction-log/INDEX.md`](.agents/friction-log/INDEX.md) before
  you start** — every entry's title and severity on one screen. Grep it for the
  file or subsystem you are about to touch.

Reading is the half that has not been working. There are fifty entries and the
instruction to `npx frog list` has been in this file the whole time; a diagnosis
written on 6 August, complete with the preventive fix, was reconstructed from
scratch on 9 August at a cost of hours. Writing an entry costs a minute. The
asymmetry is the whole argument.

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
npm run gate            # 0.2 s — does every .ts under src/ still PARSE?
npx tsc --noEmit        # must be clean
node tools/test-game.ts        # 147 assertions — rules, targeting, control
node tools/test-ai.ts          # 70  — off-ball structure
node tools/test-locomotion.ts  # 81  — movement model
node tools/test-move.ts        # 37  — body separation
node tools/test-anim.ts        # 83  — gait, foot contact
node tools/test-camera.ts      # 71  — broadcast camera
```

`npm run gate` is first because it is the only one that names the right line for
the defect this repo actually keeps hitting: a backtick inside a `/* glsl */`
comment closes the template literal, and `tsc` answers with a cascade of errors
at lines that are not the fault. Six recurrences, all by agents who had read the
warning — so it is a parser now rather than a paragraph. Both capture rigs run it
before they launch Chrome, which is also what turns a peer's half-saved file from
a 180 s puppeteer `TimeoutError` into a named file and line.

Regenerating goldens rewrites files other agents own, so **name the modules you
own**: `node --experimental-strip-types tools/gen-goldens.ts rules gamestate`
rewrites only those two. With no arguments it rewrites **all eighteen** — which
has already landed stale fixtures on `main`. (`gen-goldens.ts` with an unknown
module prints the current list; trust that over this sentence, which has been
wrong twice.) Then run the port's own suite:
`cd swift && swift run -c release SimTests` must end `PASS` with 0 failures.

### Seven assertions are red on a clean checkout. None of them is yours.

Measured at `main`. Do not chase these and do not report them as yours:

| suite | red | assertion |
|---|---|---|
| `test-game.ts` | 1 | `with no single seed outside 80-97%` — `33333` at 49% |
| `test-ai.ts` | 4 | windy completion %; reset handler stationed; reset in position at stall; ratings change on-field outcomes |
| `test-camera.ts` | 2 | `lead room on the attacking side, settled (>3s)`; `marker framed, LIVE_POSSESSION` |

All seven are per-seed or telemetry **bands**, and the friction log records that
any unrelated change flips them — see `20260809222131-enginetests-deep-game` and
`20260810-per-seed-bands-again`. `EngineTests` pools its equivalents across three
seeds for exactly this reason; these have not been pooled yet (issue #30).

**Verify before you believe this table.** It has been wrong before: it previously
named `wasted yaw travel p99` as the single known failure, and that assertion now
passes while two other camera assertions do not. A stale exception list is worse
than none, because it licenses ignoring the wrong thing. Diff against a clean
worktree rather than trusting this paragraph.

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
