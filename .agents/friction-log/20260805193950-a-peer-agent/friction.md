---
title: 'A peer agent saving any src/ file full-reloads the capture page and kills the run mid-series'
severity: 'minor'
---

Both capture rigs and every ad-hoc probe drive the dev server, and no module in
`src/` calls `import.meta.hot.accept()`. Vite's fallback for an un-accepted
update is `location.reload()`. So while a capture is running, ANY save under
`src/` by any other agent reloads the page out from under puppeteer.

What that looks like from the running process, mid-series:

    Error: Execution context was destroyed, most likely because of a navigation.
        at rewriteError (…/cdp/ExecutionContext.js:454:15)
        at async CdpPage.evaluate (…/api/Page.js:826:20)

or, if the reload lands between two of puppeteer's calls,
`TargetCloseError: Protocol error … Target closed` — which is the failure
already filed as `20260805180039-capture-live-mjs`, with the cause identified
here. It is not flakiness in puppeteer and it is not the scene: it is HMR.

Why it hurts more here than in a normal repo: this project is worked by seven
agents in parallel, each of them saving `src/` files every couple of minutes,
and a full capture run is three to six minutes long. The window is essentially
always open. The run dies partway, `_ez.json` / `_meta.json` never get written
because they are written at the end, and what is left on disk is a *short but
plausible* series of PNGs — the same trap BRIEF.md already warns about for
FROZEN runs, arrived at by a different road.

Fix, one line, in the capture rigs rather than in `vite.config.ts` (the dev
server is shared, and turning HMR off globally would be rude to whoever is
iterating by hand):

    // tools/capture-live.mjs, capture.mjs, any probe
    await page.evaluateOnNewDocument(() => {
      // capture runs must survive a peer agent saving a file
      window.__vite_plugin_react_preamble_installed__ = true;
    });

— or more directly and reliably, block the HMR socket for the capture page:

    await page.setRequestInterception(true);
    page.on('request', (r) => (/[?&]token=|__vite_ping|@vite\/client/.test(r.url())
      ? r.abort() : r.continue()));

Cheapest of all, and what I would actually ship: spawn the capture server with
HMR off for that server only —

    spawn('npx', ['vite', '--port', String(PORT), '--strictPort'],
          { env: { ...process.env, VITE_HMR: '0' } })

plus `server: { hmr: process.env.VITE_HMR === '0' ? false : undefined }` in
`vite.config.ts`. The capture rig already spawns its own server on a free port
(`freePort()` in `tools/capture-live.mjs`), so this costs nothing to anyone
working by hand.

Until then: re-run and hope, or ask peers to hold. Both are what has been
happening.
