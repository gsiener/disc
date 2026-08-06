---
title: 'The cheap ''is the tree green'' gate the peer-syntax-error entries ask for already ships in node_modules: esbuild, 0.2 s for all of src/'
severity: 'minor'
---

`20260805221042-a-peer-s` states the cost exactly right — a peer's parse error
kills your capture as a 180 s puppeteer timeout — and then says there is "no
cheap 'is the tree green' signal that does not itself take a minute
(`npx tsc --noEmit` is ~40 s on this repo)".

There is one, and it is already installed. Vite's own transform is oxc/esbuild;
`node_modules/.bin/esbuild` is present and will parse a TypeScript file without
type-checking it, which is exactly the question ("will vite 500 on this?") and
nothing more:

    ./node_modules/.bin/esbuild --loader=ts --log-level=silent FILE >/dev/null

Measured on this tree, 2026-08-05:

| gate | wall time | answers |
|---|---|---|
| `npx tsc --noEmit` | ~40 s | types AND syntax, for everyone's files |
| puppeteer `__READY__` wait | 180 s | eventually, by timing out |
| esbuild over all of `src/**/*.ts` | **0.2 s** | syntax only — the failure mode that actually bites |

Syntax-only is the right scope. Every recorded instance of this failure on this
branch has been a parse error (three backtick-in-a-GLSL-comment cases across
`Eyes.ts` / `Skin.ts` / `Hair.ts`), never a type error — a type error does not
stop vite serving the module.

What it bought me, concretely: I hit `Hair.ts:358` (a peer's file, mid-edit,
the same backtick defect) as a 180 s timeout on my first probe run. Instead of
retrying blind I put the esbuild sweep in a 15 s poll loop and got on with
reading the shader while the tree healed itself, at zero further cost. The loop
is four lines of shell.

**Two places it belongs.**

1. As a fail-fast preflight at the top of `tools/capture.mjs`,
   `tools/capture-live.mjs` and any probe: sweep `src/**/*.ts`, and if anything
   fails to parse, exit immediately naming the file and line and saying
   *whether it is one of yours*. That turns the 3-minute opaque hang into a
   0.2 s message, which is what both earlier entries asked for.
2. As the pre-hand-off gate `20260805221218-skin-ts-was` wants, run BEFORE
   `tsc` — it is 200x faster and, for this defect class, names the right line
   where `tsc` names four wrong ones.

Reproduction (the poll loop, verbatim):

    for i in {1..120}; do
      bad=""
      for f in src/**/*.ts; do
        ./node_modules/.bin/esbuild --loader=ts --log-level=silent "$f" \
          >/dev/null 2>&1 || bad="$bad $f"
      done
      [[ -z "$bad" ]] && { echo "ALL SRC PARSES"; break; }
      echo "attempt $i broken:$bad"; sleep 15
    done
