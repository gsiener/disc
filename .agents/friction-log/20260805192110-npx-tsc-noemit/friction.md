---
title: 'npx tsc --noEmit cannot verify your own work while peers are mid-edit'
severity: 'minor'
---

BRIEF.md rule 5 and AGENTS.md both require `npx tsc --noEmit` to be clean before you report. In a parallel-agent session that check is frequently unusable, because it typechecks the whole project and a peer with a half-written file fails it for you:

```
src/world/field/TurfMaterial.ts(406,54): error TS1005: ',' expected.
src/world/field/TurfMaterial.ts(406,59): error TS1005: ',' expected.
src/world/field/TurfMaterial.ts(599,47): error TS1005: ';' expected.
```

I own `src/camera/Tele.ts` and `tools/test-camera.ts`; neither appears above. This ran for several minutes of the session and also broke `tools/capture-live.mjs`, which spawns vite and waits 180 s for a page that will never build (see the sibling entry on capture-live).

**Why it costs more than the wait.** The instruction is "tsc clean", so the honest reading is that you are blocked. The tempting reading is that it is somebody else's problem and you can skip the check — and that is exactly how an agent ships a type error in its own file while telling itself the failure was a peer's.

**Workaround.** Filter to your own files and assert that, rather than skipping:

```sh
npx tsc --noEmit 2>&1 | grep -v -e 'src/world/field/TurfMaterial.ts' -e '<other peer files>'
```

Better, when you know what you own:

```sh
npx tsc --noEmit 2>&1 | grep -E 'src/camera/Tele.ts|tools/test-camera.ts' ; echo "mine: $?"
```

**What would fix it.** A line in AGENTS.md next to the `npx tsc --noEmit` instruction saying what to do when the failure is not in a file you own — that the obligation is 'no errors in YOUR files', that you should name the peer files you filtered when you report, and that a peer syntax error also wedges capture-live with an unexplained 180 s timeout. Right now every agent rediscovers all three.
