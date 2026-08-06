---
title: 'Backtick in a GLSL comment, fourth recurrence — I hit it 20 minutes after reading the entry that warns about it'
severity: 'minor'
---

Fourth occurrence on this project (see 20260805193609 and 20260805234124). I read both entries at the start of this session as instructed, then wrote

    // (smoothstep(0.41, 0.31, `lock`) * 0.76) wherever it landed

inside a `/* glsl */\`…\`` block. Cost: one typecheck round-trip, about two minutes.

The reason knowing about it does not prevent it is that it is a **habit collision**, not a knowledge gap. Backticks round identifiers are correct and encouraged in every other comment in this codebase — the file header uses them, the TSDoc above `makeHairMaterial` uses them — and the shader strings are the only place they are fatal. Nothing at the point of writing distinguishes the two contexts.

Two corrections to what the earlier entries say about diagnosing it, both checked on this tree today rather than assumed:

**1. `tsc`'s FIRST error is on the offending line.** 20260805193609 says tsc "blames the wrong line". It blames a lot of wrong lines, but not the first one:

    src/entities/material/Hair.ts(489,14): error TS1005: ',' expected.     <- exactly right
    src/entities/material/Hair.ts(489,25): error TS1003: Identifier expected.
    …
    src/entities/material/Hair.ts(667,64): error TS1005: ',' expected.     <- noise

The stray backtick *closes* the template, so the GLSL after it is parsed as TypeScript and the first thing that is not a valid expression is on that same line. Read error one, ignore the rest, `grep -n '\`' <file>` to confirm. That is the whole diagnosis and it takes ten seconds.

**2. The esbuild gate proposed in 20260805235727 is stale — esbuild is no longer installed.** `node_modules/.bin/` on this tree holds `browsers frog frog.src incur incur.src nanoid puppeteer rolldown tsc vite yaml`. Vite 8 ships rolldown/oxc, not esbuild, so `./node_modules/.bin/esbuild --loader=ts …` now fails with "no such file or directory". Anyone reaching for that pre-flight will need to route it through rolldown instead, or the entry should be marked stale.

I also drafted a one-line awk gate for this and am **not** recommending it: it produces false positives on the legitimate nested interpolations this codebase uses (`${i.quality > 0 ? \`…\` : ''}` in `Cloth.ts` and `Skin.ts`), so it cannot be a hard gate without a real lexer. Correct-looking one-liners for this are worse than nothing, because the next agent trusts them.
