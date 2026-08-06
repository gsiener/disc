---
title: 'Blocking /@vite/client makes a browser probe immune to peer agents saving files'
severity: 'minor'
---

Known friction (20260805193950, 20260805220550): a peer agent saving anything under src/ makes vite full-reload the page and kills a long-running probe. It surfaces as `Error: Execution context was destroyed, most likely because of a navigation`, which names neither vite nor the peer, and it cost this round one 90-second render.

There is a one-line fix. HMR is delivered by a script vite injects into the page; nothing else listens for the reload. Abort that request and the page still works and never reloads:

```js
await page.setRequestInterception(true);
page.on('request', (r) => {
  if (r.url().includes('/@vite/client')) r.abort().catch(() => {});
  else r.continue().catch(() => {});
});
```

Two notes for whoever copies it. Once interception is on you MUST call `continue()` on every other request or the page hangs on its first import. And the aborted request shows up as a `net::ERR_FAILED` console error, so a probe that reports console errors should filter it or it will look like a page problem it caused itself.

Live in `tools/test-audio-render.mjs`. Worth adding to `tools/capture-live.mjs` too — a 14-frame series is a much bigger target than a single render.
