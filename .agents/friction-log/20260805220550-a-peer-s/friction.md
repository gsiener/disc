---
title: 'A peer''s transient syntax error in ANY src/ file fails your capture as a 180 s puppeteer timeout, not as a compile error'
severity: 'minor'
---

## What happened

Ran the round's first baseline capture:

    node tools/capture.mjs closeup --q ultra --w 1600 --h 900 --out shots/eyesB-base

It ran for three minutes and died with:

    TimeoutError: Waiting failed: 180000ms exceeded
        at file:///.../tools/capture.mjs:118:12

The actual cause was twenty lines further up in the same output, and it was
not my file at all:

    Plugin: vite:oxc
    File: /Users/grahamsiener/src/claudeahan/src/entities/material/Skin.ts

A peer agent was mid-edit on `Skin.ts` and had it in a transiently unparseable
state. Vite could not transform it, `main.ts` never finished importing, the
page never set the ready flag, and puppeteer waited out its whole 180 s.

## Why this is worse than the known tsc friction

There is already an entry for `npx tsc --noEmit` being unusable while peers are
mid-edit (`20260805192110-npx-tsc-noemit`). This is the same root cause with a
much worse presentation:

- `tsc` at least prints `Skin.ts(201,13): error TS1005` and you know in one
  second that it is not yours.
- `capture.mjs` prints a stack trace whose top frame is `capture.mjs:118` and
  whose error class is `TimeoutError`. Everything about the surface reads as
  "the capture rig is flaky" — and there is already a filed entry saying the
  live rig wedges (`20260805180039`, `20260805180841`), so the natural
  conclusion is the wrong one. The three-minute cost is paid before you see
  any of it.

## What would fix it

`capture.mjs` already has the page's console and the vite child's stderr in
hand. Two cheap options, either is enough:

1. Fail fast on the transform error. If a vite `Plugin: vite:oxc` /
   `Internal server error` line appears on the child's stderr, abort
   immediately with `capture aborted: <file> failed to transform (peer edit
   in flight?)`. Turns 180 s into 2 s and names the file.
2. Failing that, on timeout print the last few vite stderr lines *after* the
   stack, under a header like `--- vite said ---`. One line of context beats a
   correct stack trace pointing at the waiter.

## Second-order

Because a peer's broken file is indistinguishable from my own broken file at
the capture layer, the reflex is to go audit your own diff first. In this case
that reflex was right by accident — `Eyes.ts` also had a syntax error, from a
backtick inside a GLSL comment (entry `20260805193609`), and the two were
completely unrelated. Neither tool told me there were two.
