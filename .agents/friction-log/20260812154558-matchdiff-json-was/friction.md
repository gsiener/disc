---
title: 'matchdiff.json was stale across two src/sim behaviour changes, and only rng had a freshness gate to notice'
severity: 'major'
---

`goldens-fresh` regenerated and byte-compared exactly one family, `rng`, for a good
reason (#41: the libm-sensitive families do not reproduce across platforms). The gap
that leaves is not theoretical. Measured today at `98b086e` on darwin/arm64,
node v26.7.0 — the platform and runtime `provenance.json` attributes the fixtures to,
so no platform difference is involved:

`node --experimental-strip-types tools/gen-goldens.ts matchdiff` moves 13 of the 21
counts in `matchdiff.json`:

| | committed (`bd4dbac`) | regenerated at `98b086e` |
|---|---|---|
| `block` | 50 | 37 |
| `interception` | 82 | 73 |
| `pull-drop` | 17 | 21 |
| `foul` | 21 | 34 |
| `contested` | 4 | 13 |
| `attempts` | 1672 | 1410 |
| `points` | 167 | 187 |

The fixture was last written at `bd4dbac`. `src/sim` has moved twice since in ways that
change match outcomes — `4e0c02a` (elite-vs-weak roster rating inversion, #36) and
`6bc269e` (one `Rng` for the reference) — so this is genuine staleness, not the ULP
drift `20260811070423-a-golden-regenerated` records. `MatchDiffTests` was asserting the
port against a reference that no longer exists, and nothing in CI or the suite could
say so: the fixture is only compared against the *port*, never re-derived.

`SimTests` still passes on the regenerated fixture — 2,254,037 assertions, 0 failures —
so the staleness had been hiding behind bands wide enough to hold both.

## Suggestion

Two things, both landed with this entry:

1. `check-goldens.ts freshness coeffs matchdiff` on a canonical macos-15 arm64 job. The
   comparison is meaningless on ubuntu and the checker refuses to make it there — but
   refusing on the wrong platform is not the same as not checking, and the previous
   arrangement conflated the two. It runs on pull requests: a freshness gate that only
   runs after merge cannot stop a stale fixture being merged, which is the failure above.
2. `check-goldens.ts staleness` on the foreign runner, which reads `provenance.json` and
   `git log` and names the family, the canonical platform, and the kind of staleness. It
   would have printed `history-source-newer` for `matchdiff` here, with the two commits
   that caused it.

The trap to avoid if you touch this again: history staleness has a known false positive
(a commit touching `src/sim` need not touch a given family), so it is a warning, and only
the two provenance-derived kinds — foreign platform, dirty oracle — fail `--strict`.
