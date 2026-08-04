# Agent instructions

**Read [BRIEF.md](BRIEF.md) first.** It is the engineering contract for this
repository — file ownership, the zero-binary-assets rule, determinism, the
quality tiers, and which capture rig to use for what. Nothing here replaces it.

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

`tools/test-camera.ts` has one known failure, `wasted yaw travel p99`. That
metric is documented in the file as unstable under changes that are not the
camera's — it scored 8.65, 11.49, 11.51, 12.48 and 14.25 across five successive
states of `src/sim/AI.ts`. Do not chase it, and do not report it as yours.

And **look at the pixels**. `tools/capture.mjs` pins the camera and freezes the
world, which is right for judging a material and useless for judging anything
that moves; `tools/capture-live.mjs` releases both and photographs real play.
See BRIEF.md for the operational traps in both.
