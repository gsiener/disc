---
title: 'matchdiff.json is stale on main, so any agent who regenerates it inherits somebody else''s behaviour change and a red suite'
severity: 'major'
---

## Description

`swift/Sources/SimChecks/Goldens/matchdiff.json` was last regenerated at `c491099`. `src/sim/`
has changed since, at `c2460aa` ("A team can call a timeout, and a windy day is a zone day",
issue #20), without a matchdiff regeneration. The fixture is eleven full reference matches,
so it is sensitive to any change in the sim — and the committed file therefore describes a
reference that no longer exists.

`SimTests` is green anyway, because `MatchDiffTests` compares *rates* inside stated bands
and the drift has not crossed one. So nothing is failing, and nothing will point at this
until somebody regenerates.

## How it showed up

Working on issue #4, I regenerated `matchdiff` after a gameplay change, and `SimTests`
failed with:

> turnover:out-of-bounds happens in the port too — the reference has 5 over 11 matches and
> the port has none, which is a severed wire rather than a different roll

That is `MatchDiffTests`' reachability-parity check, which is the assertion in this
repository with the best record — it is the one that caught #55. It reads as a serious
finding about my change. It is not one: reverting my change entirely and regenerating still
moves the file by fifteen counts, so the delta was already sitting on `main`.

The failure is real in the sense that the port genuinely produces zero out-of-bounds
turnovers where the current reference produces five. That is worth an issue. But it belongs
to whoever landed `c2460aa`, and the only thing connecting it to me is that I was the next
person to run the generator.

Costed roughly forty minutes: an eight-minute suite run to see the failure, a four-minute
regeneration to attribute it, and the reasoning in between, which starts from the assumption
that a golden in the tree describes the code in the tree.

## What would help

Two options, in order of cheapness:

1. **A staleness check.** `git log -1 --format=%h -- <golden>` against
   `git log -1 --format=%h -- <its inputs>` is a shell one-liner per fixture, and the answer
   is already in the repository. Run in CI it would name the stale fixture and the commit
   that stranded it, instead of ambushing the next agent who touches that area.
2. **Regenerate `matchdiff` on any `src/sim/` change**, which is what `AGENTS.md` already
   implies and what nobody can be relied on to remember, because the fixture costs four
   minutes and the suite stays green without it.

The general shape, which is worth stating because this repository has sixteen fixtures and
one of them is slow: **a golden that is expensive to regenerate and forgiving when stale
will go stale, and its cost lands on the next person rather than the one who caused it.**
