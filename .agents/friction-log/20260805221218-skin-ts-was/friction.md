---
title: 'Skin.ts was handed over in a state that cannot compile: three backtick pairs inside GLSL comments, added after the reference screenshot was taken'
severity: 'minor'
---

## What happened

I was given `shots/faces/closeup.png` as "the current face" and told a known
`expo` cliff fix had already landed in `src/entities/material/Skin.ts`.
Both statements were true separately and false together.

- `shots/faces/closeup.png` mtime `Aug 5 21:06:10`
- `src/entities/material/Skin.ts` mtime `Aug 5 21:58:57` (uncommitted, +70/-27)

The working-tree edit does not parse. Lines 201, 213 and 215 sit inside the
`before:` template literal that starts at line 163, and each contains a
backtick pair in a **GLSL** comment:

```
201:        // `isPart` reads a vertex attribute that is constant per loft, ...
213:        //   • a `+ pFore` term added to close a forearm/wrist seam. ...
215:        //     humerus and forearm as one PART.UPPER_ARM — so `pFore` is
```

`//` does not comment anything out inside a template literal. Six backticks
split one template into four, with bare JS tokens between them. `tsc` reports
`TS1005 ',' expected` and vite 500s the whole dev server, so **no capture rig
can render the file at all** — the material has not been built since 21:58.

## Why it cost time

This is the second recurrence of `20260805193609-a-backtick-in`. What is new,
and what that entry does not cover, is the **hand-off failure mode**:

1. The screenshot I was told to diagnose predates the edit I was told had
   landed, so the render shows HEAD's `expo` (noise amplitude `0.35`,
   `pFore` term that is identically zero) and not the working tree's
   (amplitude `0.18`, junction constants). I spent the first half hour
   attributing HEAD's defect to code that has never executed.
2. `npx tsc --noEmit` names the right file, so it is catchable — but the
   handover briefing said "re-run tests at the end", and a broken file that
   nobody can build is only discoverable at the *start*.

## Suggested fixes

- A pre-hand-off gate: an agent's round is not finished until
  `npx tsc --noEmit` is clean **for the files it owns**, and the reference
  screenshot is re-taken after the last edit. A screenshot older than the
  source it is supposed to depict is a lie with a timestamp on it.
- Mechanical: in GLSL comments inside these template literals, quote
  identifiers with `'` and never with a backtick. A one-line lint over
  `src/entities/material/*.ts` catching `` /^\s*\/\/.*`/ `` inside a
  `/* glsl */` block would have caught this in both files.
- Today it was in two files at once: `src/entities/material/Eyes.ts:311`
  (`` `socket` ``) has the identical break, which is what 500s vite first.
