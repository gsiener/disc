---
title: 'The friction log''s own proposed esbuild gate is stale: esbuild is not installed, and vite 8''s rolldown/oxc parser is a better gate anyway'
severity: 'minor'
---

Issue #31 and `20260805235727-the-cheap-is` both say the cheap syntax gate is
`node_modules/.bin/esbuild`. It is not, and has not been since vite 8:
`node_modules/.bin` holds `browsers frog incur nanoid puppeteer rolldown tsc vite
yaml`, and no `esbuild` package exists anywhere in the tree.
`20260806014822-backtick-in-a` caught this and was right; the two entries either
side of it still recommend the stale command, so anyone reading in index order
reaches for a binary that is not there.

The replacement is better than the thing it replaces. Vite 8 transforms with
rolldown/oxc, and rolldown exposes that parser directly:

    import { parseAst } from 'rolldown/parseAst';
    parseAst(readFileSync(file, 'utf8'), { lang: 'ts' });

So the gate does not approximate the question "will vite 500 on this?" — it asks
the component that would do the 500-ing. It throws a `RolldownError` with `pos`
as a **UTF-16 offset** into the source (not a UTF-8 byte offset — checked against
a file with em dashes ahead of the fault) and a rendered snippet with a caret.

Measured on this tree today, 138 files, ~3 MB of TypeScript under `src/`:

| gate | wall |
|---|---|
| `rolldown/parseAst` over all of `src/` | **0.20 s** (0.36 s incl. node start) |
| `npx tsc --noEmit` | ~1.0 s (typescript 7 is much faster than the ~40 s the older entries measured) |
| `swiftc -parse` over all 98 `.swift` | 7.1 s |

Two corrections to the record while I was in here. `npx tsc --noEmit` is now
about a second, not the ~40 s that `20260805221042-a-peer-s` and
`20260805235727-the-cheap-is` both cost their arguments on — so "syntax gate
because tsc is slow" is no longer the reason. The reason that survives is
accuracy: on a single stray backtick in `TurfMaterial.ts`, `tsc` emitted **183
errors** across a 945-line file, one of which was the fault. The gate emits one,
on the right line, with a caret under the character.

Shipped as `tools/gate.mjs` / `npm run gate`, wired into both capture rigs and
into CI.
