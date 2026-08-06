---
title: 'capture-live.mjs has no input driver, so the human player is a statue and stalls every possession he starts'
severity: 'major'
---

`tools/capture-live.mjs` releases `director.unpin()` and `game.posed` and lets the
match run, but it never publishes any input. The human-controlled player
therefore never moves.

That is survivable off-ball. It is not survivable when the controlled player is
the thrower: he stands still holding the disc for the whole stall count while
the AI mills around him, and the capture photographs a dead possession.

## Impact

It corrupted a blind critique. Three of the animator critic's four CRITICAL
findings against `shots/r8-final/` were this artefact, not the game:

- "Thrower and marker are pixel-identical across 3 frames / 4 seconds of sim"
- "No run cycle exists anywhere in 10 frames"
- "The player I control is frozen for the final 4 frames — 6 seconds of sim —
  while the stall clock runs"

Measured directly: over the same window 10-13 of 14 players move per 2 s and
possession turns over at t=25 s. The match was healthy; the sample was not.

An earlier agent hit this and worked around it privately — its probe notes say
it "added a move-stick driver so the controlled body actually moves on screen" —
so this has now cost two rounds independently.

## Reproduction

```sh
node tools/capture-live.mjs --n 10 --gap 2.0 --q high --w 1280 --h 720 --out shots/x
python3 - <<'PY'
import json; d=json.load(open('shots/x/_live.json'))
for r in d['rows']: print(r['simT'], r['phase'], r['p0'])
PY
```

`p0` repeats verbatim across consecutive frames whenever the controlled player
holds the disc, while `simT` advances.

## Suggested fix

Either drive a synthetic stick (deterministic, seeded — it must not break the
rig's byte-reproducibility), or hand the controlled body back to its own AI for
the duration of a capture. `GameSystem.idleCollector()` already does exactly the
second thing for a dead disc after 1.0 s of no input; the same treatment during
LIVE_POSSESSION would fix this. A `--ai-only` flag on the capture tool is
probably the smallest correct change.
