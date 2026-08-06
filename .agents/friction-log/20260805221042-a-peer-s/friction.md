---
title: 'A peer''s syntax error takes down every other agent''s capture rig for 3 minutes and reports it as a puppeteer timeout'
severity: 'minor'
---

`tools/capture.mjs` and `tools/capture-live.mjs` boot a fresh `vite` dev server and wait on `window.__READY__`. If ANY file in `src/` currently has a syntax error — including one in a file you do not own and are not importing — vite's transform fails, the module graph never finishes, `__READY__` never flips, and the run dies after 180 s with:

```
TimeoutError: Waiting failed: 180000ms exceeded
    at ... tools/capture.mjs:118:12
```

The real cause (`Plugin: vite:oxc / File: src/entities/material/Eyes.ts`) is printed ~40 lines earlier in the same stream and is easy to miss, especially since the exit is a puppeteer error and reads like a rig problem.

Observed twice in one session on this branch: `Eyes.ts` then `Skin.ts`, both from the round-7 face agents, both the backtick-in-a-GLSL-comment failure already logged as `20260805193609-a-backtick-in`. Six parallel agents editing adjacent files means the tree is un-buildable a large fraction of the time, and every agent burns 3 minutes to find that out.

**Cost.** Three minutes per attempt, and the attempt has to be retried blind because there is no cheap 'is the tree green' signal that does not itself take a minute (`npx tsc --noEmit` is ~40 s on this repo).

**Suggested fix.** Have `capture.mjs` fail fast: subscribe to the vite server's `stderr`/plugin-error stream (or the page's `console`/`pageerror`) and abort with the offending file and line as soon as a transform error appears, instead of waiting out the full `waitForFunction` timeout. A one-line `page.on('pageerror', ...)` that rejects the ready-wait would turn a 3-minute opaque hang into a 5-second 'src/entities/material/Skin.ts(201,13): syntax error — not your file'.
