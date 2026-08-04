---
title: 'tools/capture.mjs freezes the world, so it cannot verify anything that moves'
severity: 'major'
---

`tools/capture.mjs` pins the camera via `applyShot()` **and** sets `game.posed`.
`Game.update` only counts `poseHold` down when `ctx.capture` is false, so in the
rig a posed tableau is held for ever, by design.

That is correct for photographing a material, a texture or a piece of geometry.
It is useless for photographing anything that moves — a camera, an animation, a
reactive interface — because the framing under assessment is exactly the thing
the pin overrode.

## Impact

Five rounds of blind visual critique on this project scored **still lifes**
without anyone noticing, including the round that was specifically supposed to
judge the broadcast camera. The scores were real; what they measured was not
what we thought.

Worse, the first attempt at a live rig looked like it worked. A wedged Chrome
screenshot path still wrote six plausible PNGs and exited 0, and a frozen frame
series is indistinguishable from a working one by eye. It fooled a reviewer
(me) into reporting that the camera was fine.

## Reproduction

```sh
node tools/capture.mjs broadcast   # every frame identical, by design
node tools/capture-live.mjs --n 6 --gap 2.5 --q high --w 1280 --h 720
```

The second releases `director.unpin()` and `game.posed`, prints `simT`, disc and
player positions per frame, and shouts `FROZEN` if nothing moved between them.

## Suggested fix

Done, partially: `tools/capture-live.mjs` exists and BRIEF.md now documents
which rig judges motion. What is still missing is a guard on the pinned rig
itself — it should refuse, or at least warn loudly, when asked to judge
something the pin has overridden. Right now knowing which tool to reach for is
tribal knowledge held in a markdown file.
