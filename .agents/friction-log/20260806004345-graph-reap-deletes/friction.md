---
title: 'Graph.reap() deletes every transient from an OfflineAudioContext render before it makes a sample'
severity: 'minor'
---

Any offline render driven by a virtual clock measures the persistent beds and NOTHING ELSE. Every one-shot in the game — footsteps, the disc release snap, the catch slap, the ground thud, the layout impact, the goal horn, the gasp — renders as digital silence.

`AudioGraph.reap(now)` calls `release(v, false)` on any voice whose `end <= now`, and that path does `s.stop(t)` and then **disconnects the nodes synchronously**. In real time that is correct and deliberate: `end <= ac.currentTime` means the audio thread has already rendered the voice, so dropping it is free. Against an OfflineAudioContext nothing is rendered until `startRendering()`, so a voice created at virtual t=3.0 and reaped at virtual t=3.1 has been removed from the graph before a single sample exists.

Measured, footsteps fired at six distances from the listener:

| | reaping (as shipped) | reap neutered |
|---|---|---|
| 11 m | -113.5 dBFS | -40.9 dBFS |
| 15 m | -115.0 | -39.8 |
| 23 m | -113.8 | -42.1 |
| 37 m | -113.0 | -43.8 |
| 58 m | -115.0 | -53.0 |

Flat and 70 dB down at every distance — the tell is that the distance law is *absent*, not merely steep. 22 footsteps were confirmed to fire, pass the cull, and claim a voice; all 22 were then disconnected before rendering.

This silently invalidated the field stem in `tools/_audioprobe.mjs`: its `peak 0.7233 (-2.8 dBFS)` is crowd beds and the disc's persistent flight whirr, and its offline render has never once contained a footstep or an impact.

FIX for any offline rig: replace `graph.reap` with a version that evicts from the pool array without disconnecting, so `claim()` still behaves and the nodes survive to render. Their own scheduled `stop()` still ends them.

```js
sys.graph.reap = function (now) {
  for (let i = this.voices.length - 1; i >= 0; i--) {
    if (this.voices[i].end <= now) this.voices.splice(i, 1);
  }
};
```

`tools/test-audio-render.mjs` does this. Reproduction in artifacts/_fieldcount.mjs.
