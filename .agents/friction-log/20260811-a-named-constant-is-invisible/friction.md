---
title: 'Adding `export` to a reference constant deletes it from the divergence registry, and the failure names the wrong cause'
severity: 'major'
---

## Description

`tools/goldens/divergences.ts` scrapes every module-scope numeric constant out of
`src/sim/AI.ts` so that `DivergenceTests` can assert each one against a live Swift
symbol. That is the half of ADR-0007 that makes an *undeclared* divergence fail: the
default is equality, and nobody has to remember to write a check.

The scrape was:

```ts
const re = /^const ([A-Z][A-Z_0-9]*) = (-?\d+(?:\.\d+)?);/gm;
```

`^const` — so `export const CATCH_FLOOR = 0.85;` does not match. Issue #4 needed those
constants importable by a golden generator, which meant adding `export` to six of them.
Every one silently left `referenceConstants`, and `DivergenceTests` then reported:

> `CATCH_FLOOR` is bound in `mirrored` but the reference no longer declares it — drop
> the binding or declare the divergence

The reference declares it. It is on the same line it has always been on, with the same
value. What changed is a keyword that has nothing to do with the number, and the failure
message actively recommends the wrong repair: dropping the binding would have removed
the constant from the registry permanently, which is the exact outcome the registry
exists to prevent, and it would have looked like a clean fix.

## Why it cost time

The suite designed to catch a silent divergence produced a message pointing at the
reference, when the reference had not moved. Widening the pattern to
`^(?:export )?const` is a two-character fix; finding it means suspecting the scraper
rather than the thing it is scraping, and the whole premise of that file is that the
scrape is the trustworthy half.

The general shape is worth stating because this registry will grow: **a pattern that
matches source text is matching a syntax, and any part of that syntax which is not the
value is a false dependency.** `divergences.ts` says as much about its *site* patterns —
"must be tight enough that editing the expression around it stops matching" — which is
right for a site, where the surrounding expression is what gives the number meaning. It
is wrong for a declaration, where `export` is visibility and carries no meaning at all.

## What would help

Beyond the fix (landed): a check that the constant count did not *drop* between
regenerations would have caught this at the generator rather than in the Swift suite two
builds later. `divergences.ts` already warns to stderr when a site pattern stops
matching; the same courtesy for `referenceConstants` shrinking is four lines.
