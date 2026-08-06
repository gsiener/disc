---
title: 'capture-live.mjs wedges on Page.captureScreenshot at 1280x720 too, not just 1080p'
severity: 'minor'
---

BRIEF.md says to use `--w 1280 --h 720` because "at 1920x1080 against a 30 M-triangle scene Chrome's screenshot path wedges partway through the run". It also wedges at 1280x720.

Two consecutive runs on an M1 Max, `--n 6 --gap 2.5 --q high --w 1280 --h 720`:

- run 1: died on frame 00, 0 PNGs, `ProtocolError: Page.captureScreenshot timed out` (protocolTimeout is 240 s).
- run 2 (after `pkill -f '[v]ite'`): frames 00-02 written and logged fine, died on frame 03 with the same error.

So `--n 6` is not reliably survivable at 720p either. What worked, repeatedly, was **`--n 3`** — three frames, then let the process exit and start a fresh one for the next three. The failure is always the *screenshot* call, never `advance()`/`render()`, and it gets more likely the longer a page has been alive, which points at the page rather than at the frame cost.

Practical guidance for the next agent:
- budget 3 frames per invocation, use a different `--out` per invocation, and treat a run that produces fewer PNGs than `--n` as a wedge rather than as a result;
- the tool exits non-zero with a node stack when this happens, so a shell `&&` chain will stop — but any PNGs already written are valid and readable;
- `pkill -f '[v]ite'` between runs is still needed, the wedged run leaves its vite child behind.

A fix inside the tool would be to relaunch the browser every N frames, or to set `protocolTimeout` far higher and accept slow frames.
