---
title: 'Backtick in a GLSL comment, fifth and sixth recurrence: I hit it twice in one session having read the entry that warns about it, and esbuild takes 0.05 s to catch it'
severity: 'minor'
---

## Recurrence count

There are already entries for this at
`20260805193609-a-backtick-in` and `20260806014822-backtick-in-a` (whose title
is 'fourth recurrence — I hit it 20 minutes after reading the entry that warns
about it'). I hit it twice more in this session, both times writing the kind of
comment the codebase's house style actively encourages:

```
// A shade wider than `limbus` so the coat feathers out ...
// the wet term below already carries the ambient
```

Backticks around identifiers are correct Markdown and correct for every *other*
comment in these files. Inside a `/* glsl */`…`` template literal they close
the string, and the error surfaces as a TypeScript parse failure pointing at a
line number that has nothing to do with it — or, if it is a peer's file, as a
180-second puppeteer timeout in *your* capture run.

## The cheap guard exists and is not wired up

Entry `20260805235727-the-cheap-is` already found that esbuild ships in
`node_modules` and checks all of `src/` in 0.2 s. Per-file it is faster still:

```
$ npx esbuild --bundle src/entities/material/Eyes.ts --outfile=/dev/null --loader:.ts=ts
  ../../../../dev/null  523.0kb
⚡ Done in 50ms
```

I ran that before every one of the fourteen captures in this round and it caught
both backticks instantly, which turned a 3-minute failed capture into a 50 ms
retry. Two suggestions, either of which retires the whole class:

1. A pre-capture step in `tools/capture.mjs` that esbuilds `src/` first and
   refuses to launch Chrome if it fails — this also fixes the 'peer's transient
   syntax error fails your capture as a puppeteer timeout' entries, which is
   three more pending entries collapsing into one guard.
2. House style: **no backticks inside `/* glsl */` template literals.** Use
   plain identifiers. Six recurrences is a style rule, not a series of accidents.
