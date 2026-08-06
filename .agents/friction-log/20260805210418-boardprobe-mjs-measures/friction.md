---
title: '_boardprobe.mjs measures only one of the venue''s three board surfaces, so a repeat that moves between them reads as fixed'
severity: 'minor'
---

`tools/_boardprobe.mjs` is the repo's board-repeat probe and it only ever looks at `led-perimeter`. The venue has **three** surfaces that carry the same eight-brand strip or a tiled print:

| surface | mesh | probe before today |
|---|---|---|
| pitch-side LED ring | `led-perimeter` | `_boardprobe.mjs` |
| printed club/competition hoarding | `club-boards` | none |
| roof fascia ribbon | `led-ribbon` | none |

This is not a theoretical gap. The round that fixed the LED ring **moved the repeat onto the other two**, and every probe in the repo said it was fixed:

- `_boardprobe.mjs` on the shipped build: `slots 7, distinct 7, dupes: none` in all four frames. Genuinely fixed.
- The same build's `club-boards`, measured with a new probe: the run behind the play tiled ONE design, so the tele frame read `CHAMPIONSHIP SERIES · MATCH 4 · CHAMPIONSHIP SERIES · MATCH 4` at a ~190 px repeat period in a 1280 px frame — four times tighter than the ~830 px period the original critique complained about.
- The same build's `led-ribbon` at the `night` framing: `15 cells, 8 distinct, longest in-loop run 8`, seven of the eight brands twice. An in-loop run of 8 is the entire sponsor loop laid down in order and then started again — the exact failure the ribbon's own docstring claimed to have fixed.

Both surfaces carry a docstring asserting the fix. Neither assertion had a number behind it, and the one probe that existed could not have caught either.

**Also**: `_boardprobe.mjs` needs the live tele camera, but the ribbon is never in the tele frame — it only appears in the pinned establishing shots. So a ribbon probe has to drive `__RIG__.shot(name)` rather than `unpin()`, which is a different rig. That is probably why it was never written.

Added two probes alongside the existing one:

- `tools/_hoardprobe.mjs` — walks `club-boards`, resolves each quad to one of the 8 printed faces, reports per-frame duplicates at the live tele framing plus the ring-wide closest repeat in metres.
- `tools/_ribbonprobe.mjs` — same idea for `led-ribbon`, but applies a **named shot** (`--shots night,stadium`) because that board is only ever seen in pinned framings.

Suggestion: whatever the board-repeat convention becomes, it should name all three meshes, and `_boardprobe.mjs`'s output should say which surface it measured so a clean result cannot be read as 'the boards are fine'.
