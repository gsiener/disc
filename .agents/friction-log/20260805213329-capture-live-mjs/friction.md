---
title: 'capture-live.mjs has no input driver, so a human-controlled thrower is a statue and stalls every possession he starts'
severity: 'major'
issue: 'gsiener/disc#52'
---

`tools/capture-live.mjs` releases `director.unpin()` and `game.posed` and lets the match run live, but it never publishes any input. The human-controlled player therefore never moves.

That's survivable off-ball. It isn't survivable when the controlled player is the thrower: he stands still holding the disc for the entire stall count while the AI mills around him, and the capture photographs a dead possession as if it were representative play.

## Measured impact

This corrupted a blind visual critique. Three of an animator critic's four CRITICAL findings against one capture series were artefacts of this bug, not the game — "thrower and marker are pixel-identical across 3 frames," "no run cycle exists anywhere in 10 frames," "the player I control is frozen for the final 4 frames while the stall clock runs." Measured directly over the same window, 10-13 of 14 players actually moved per 2 s and possession turned over at t=25 s — the match was healthy, the sample wasn't.

An earlier agent hit the same thing and worked around it privately (a probe note describes adding a move-stick driver so the controlled body actually moves on screen), so this has cost at least two rounds independently without landing a fix in the tool itself.

## Reproduction

```sh
node tools/capture-live.mjs --n 10 --gap 2.0 --q high --w 1280 --h 720 --out shots/x
python3 - <<'PY'
import json; d=json.load(open('shots/x/_live.json'))
for r in d['rows']: print(r['simT'], r['phase'], r['p0'])
PY
```

`p0` repeats verbatim across consecutive frames whenever the controlled player holds the disc, while `simT` advances.

## Suggested fix

Either drive a synthetic stick (deterministic, seeded, so the rig's byte-reproducibility survives), or hand the controlled body back to its own AI for the duration of a capture. `GameSystem.idleCollector()` already does the second thing for a dead disc after 1.0 s of no input; the same treatment during `LIVE_POSSESSION` would fix this. A `--ai-only` flag on the capture tool is likely the smallest correct change.

Source: `.agents/friction-log/20260805213329-capture-live-mjs/friction.md`
