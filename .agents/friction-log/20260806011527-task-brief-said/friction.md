---
title: 'Task brief said the file was untouched ground; the whole feature was already in HEAD with six probes for it'
severity: 'minor'
---

My task for this round opened with:

> An agent was given this task last round and STALLED on all six attempts
> without writing anything, so this is untouched ground. Do not assume any of
> it is done.

It was not untouched ground. `src/world/field/TurfMaterial.ts` in HEAD already
contains the entire endzone cross-cut -- the 45-degree mirrored lay, the
`uCrossCut` A/B uniform, `uEzDC` / `uEzLift` / `uEzAO`, a 60-line sizing-rule
comment, and a note recording that three of those uniforms had been dead on
arrival because they were declared in the prelude and never added to the
uniforms object. Alongside it, `tools/` holds six purpose-built probes for
exactly this question: `_ezprobe.mjs`, `_ezprobe2.mjs` (A/B variant sweeps over
the endzone uniforms, at the shipped tele framings, in sun and with the
directional lights zeroed), `_ezlive.mjs`, `_ezlook.mjs`, `_ezscan.mjs`,
`_ezsweep.mjs`.

The agent that "stalled without writing anything" evidently stalled AFTER
writing a great deal of it, or a different agent wrote it. Either way the
hand-off said the opposite of what the tree contained.

That is expensive in a specific way. The instruction "do not assume any of it
is done" is an instruction to start from scratch, and starting from scratch
here means re-deriving a design that is already in the file, complete with the
reasons that three obvious variants of it were rejected -- 90 degrees instead
of 45, a wider cross band, the DC term folded inside the clamp. Each of those
rejections cost a measured sweep. Re-litigating them would have burned the
round and, worse, would probably have landed on one of the rejected variants.

What actually saved it was cheap and should be the documented first step of any
round in this repo: `git log --oneline -- <the file you own>` and
`git diff <that file>` before reading the task's framing as fact. The task
brief is a hypothesis about the tree; the tree is the tree. Suggest AGENTS.md
say so, next to "Run `npx frog list` first" -- the two are the same instinct.
