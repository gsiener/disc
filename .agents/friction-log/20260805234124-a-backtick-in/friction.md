---
title: 'A backtick in a GLSL comment is now on its third recurrence, and reading the existing entry does not prevent it'
severity: 'minor'
---

Third time on this branch: `20260805193609-a-backtick-in` (Eyes.ts), then
`20260805221218-skin-ts-was` (Skin.ts, three pairs at once), now Skin.ts again
at line 511 — mine, written twenty minutes after I had read both of the
earlier entries and explicitly noted the trap.

That is the finding. **This defect is not preventable by documentation.** Every
agent who has hit it had already been told about it. It is a muscle-memory
failure: markdown prose is the medium these agents write comments in all day,
and `\`identifier\`` is the correct way to quote a symbol in every other file in
the repo. The one place it is fatal looks identical while you are typing it.

Cost this time, for one character:

- `npx tsc --noEmit` -> 5 errors, all with misleading positions (511, 591, 746,
  765 — only the first is real; the rest are the parser re-syncing).
- A capture launched in the same command block died at the vite 500, which is
  the 3-minute failure mode already logged twice as
  `20260805220550-a-peer-s` / `20260805221042-a-peer-s`. I paid it as well, on
  my own file, so the "it is probably a peer" heuristic those entries teach
  actively pointed the wrong way.

**The fix has to be mechanical.** The one-line lint the earlier entry suggested
is worth writing now that the recurrence rate is 3/3 agents:

    # any // comment containing a backtick, inside src/entities/material/*.ts
    rg -n '^\s*//.*`' src/entities/material/*.ts src/entities/rig/*.ts

That has no false positives today. It belongs in the same pre-hand-off gate
`20260805221218-skin-ts-was` asks for, and it should run BEFORE `tsc`, because
it names the character and the line where `tsc` names four lines and the wrong
reason.

Cheaper still, and worth doing at the same time: `at()` / `prelude()` in
`src/entities/material/Glsl.ts` are the only functions these GLSL strings are
ever passed to. A dev-only assert in there — throw if the incoming string
contains a backtick — turns this from a parse error at build time into a named
error at the call site.
