---
title: 'capture-live.mjs dies mid-run with TargetCloseError and leaves a short series'
severity: 'minor'
---

`tools/capture-live.mjs` intermittently crashes partway through a run when other agents are also driving Chrome:

```
TargetCloseError: Protocol error (Page.captureScreenshot): Target closed
    at CallbackRegistry.clear (puppeteer-core/lib/puppeteer/common/CallbackRegistry.js:82:36)
    ...
    at async tools/capture-live.mjs:178:3
```

It happened twice in a row here: `--n 6` wrote 5 PNGs then died, `--n 5` wrote 2 PNGs then died. Same command, same seed, different frame count each time — so it is load, not content.

**Why it costs time.** The failure mode is the *opposite* of the FROZEN trap BRIEF.md documents. There the run exits 0 with plausible frames; here it exits non-zero, but it has *already written* a valid, correctly-rendered, shorter-than-requested series. If you only check `ls shots/<out>`, everything looks fine and you silently compare a 5-frame series against a 2-frame one and think the sim diverged. The frames that do get written are good — nothing is wrong with them.

**Workarounds that worked.**
- Re-run; the frame it dies on moves.
- Always `ls shots/<out>` and compare `live-NN` counts before drawing any A/B conclusion, and pin the comparison on the on-screen scoreboard clock (POINT / TIME) rather than on the frame index, because index N is not the same sim instant across two runs of different length.

**What would fix it in the tool.** Wrap the `page.screenshot()` at capture-live.mjs:178 in a retry, and on unrecoverable failure print how many frames were actually written and exit non-zero with that count in the message, so a partial series announces itself the way a frozen one does.
