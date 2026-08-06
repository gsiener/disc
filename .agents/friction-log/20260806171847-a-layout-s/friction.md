---
title: 'A layout''s reach is modelled three different ways in three files and none of them agree'
severity: 'major'
---

## Description

`layoutExtend(p)` in `src/sim/AI.ts` is documented as "extra metres a full-extension layout buys" and scales 0.85-2.15 m with agility and jumping. The AI makes every bid decision against it.

The rules engine does not use it. `src/sim/Game.ts` `tryCatch` awards a catch inside a **flat** radius:

```ts
const CATCH_REACH = 0.82;   // standing
const LAYOUT_REACH = 1.55;  // fully extended
const reachXZ = laidOut ? LAYOUT_REACH : CATCH_REACH;
```

So a layout buys exactly 0.73 m no matter who is diving, and `layoutExtend` buys nothing the rules will honour.

`tools/test-ai.ts` has a third model in its own contest resolver:

```ts
let reach = attacking ? 1.05 : 0.80;
if (act && act.kind === "bid" && bidWindow) reach += layoutExtend(p) * 0.60;
```

which is 1.56-2.34 m attacking and 1.31-2.09 m defending.

## Why it cost time

The AI's bid gate was `gap < layoutExtend(p)`, so it was authorising dives out to 2.15 m for a body that physically reaches 1.55 m. Those bids land on the chest and cost 2 s of recovery for nothing — measured, defensive bids touched the disc 4.7% of the time. Diagnosing that meant reading all three files and noticing they disagreed; nothing in AI.ts hints that its own athleticism model is advisory.

`CATCH_REACH` and `LAYOUT_REACH` are also the only numbers that say whether leaving your feet buys anything at all, so any AI decision about diving has to quote them — and it can only quote them by copying the literals, because AI.ts must not import Game.ts.

## What would help

One shared source for the physical constants the rules engine enforces (reach radii, the standing catch height band), imported by AI.ts, Game.ts and the test harnesses — or, failing that, a comment on `layoutExtend` saying it is an AI-side preference and not a reach the engine pays out on.
