---
title: 'The OfflineAudioContext probe measures the graph''s startup ramp, not the match'
severity: 'minor'
---

`tools/_audioprobe.mjs` renders 8 s of real WebAudio and asserts `goal 3.5-5s > bed 0-1s`. That assertion cannot fail.

The render starts at t=0 with a graph that has just been built: `AudioGraph` opens the master at 1e-4 and `AudioSystem.start()` ramps it with `setMaster(0.85, 1.4)` — a `setTargetAtTime` with tau 1.4, so it is still 8% short at t=3 s. Every crowd bed is simultaneously gliding up from 1e-4 with taus of 0.25-0.9 s.

The measured envelope is therefore monotonic for the first four seconds no matter what the match does:

```
   0s |  -57.9  -46.1  -40.7  -37.5
   1s |  -34.7  -31.6  -29.8  -28.6
   2s |  -27.4  -26.6  -26.0  -25.8
   3s |  -25.5  -21.5  -17.3  -16.0
```

The catch at 2.17 s is invisible; it is buried under a 30 dB fade-in. 'signal that rises on a goal' is really 'signal that rises', and it would still pass with every event handler deleted.

Fix for any offline render used as a measurement: force the master to its final value (`graph.setMaster(v, 0.001)`) and drive several virtual seconds of settle BEFORE the measured window, so the beds are at rest when the first comparison is taken. `tools/test-audio-render.mjs` does this — 6 s of settle, then a 20 s scripted point.
