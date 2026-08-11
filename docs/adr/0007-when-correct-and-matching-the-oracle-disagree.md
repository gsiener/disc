# ADR-0007 — When "correct" and "matches the oracle" disagree

- **Status:** Accepted
- **Date:** proposed 2026-08-10, decided 2026-08-10 (issue #24)

## Context

[ADR-0001](0001-the-typescript-reference-is-the-oracle.md) makes the TypeScript reference the
oracle: Swift mirrors it, and disagreement is settled by running the reference. That is what
makes 2.25 M assertions meaningful.

It also means the port has **no cheap way to be right when the reference is wrong.** Making
Swift correct requires:

1. a deliberate, permanent divergence from the oracle,
2. a golden regeneration,
3. and a note at the site explaining a mismatch that will otherwise read as a porting bug
   forever.

Matching the reference costs nothing. So the incentive is always to match.

## The evidence that this is a real pathology, not a hypothetical

`AIMath.swift:96` declares:

```swift
LAYOUT_CEILING = 1.10
```

with a twelve-line doc comment **proving** that the `1.85` the bid guards use is unreachable,
because `land.y` is clamped to `CATCH_CEILING = 1.45`.

`LAYOUT_CEILING` has **zero references outside its declaration.** The three real sites still
say `1.85` (`TeamAIDefence.swift:576,579`) and `1.9` (`TeamAIThrow.swift:614`), because
`src/sim/AI.ts:3228` says `1.85`.

Someone did the analysis, wrote down the correct number, and did not wire it up. That is not
carelessness — it is the incentive working exactly as designed.

The same shape recurs:

- `EngineHuman.swift:437` uses a horizontal contest radius as a height band, under a comment
  naming `CatchDecision` as its authority (issue #4). **Fixed 2026-08-11, and it needed no
  divergence at all**: `EngineHuman` has no counterpart in `src/sim/`, so there was no
  oracle to disagree with and the site had been sitting in this list under the wrong
  diagnosis. The number is now `CATCH_CEILING`, the band's actual ceiling, and
  `CatchDecision.contestRadius` is named so a radius cannot be mistaken for a height again.
  Worth recording as a limit of this ADR's own framing: some of the family is not the
  incentive at all, it is a quantity that was never named.
- `PlayerAction.bid(extend:)` is computed per player and discarded at `Engine.swift:878`
  (issue #22) — the capability exists, is plumbed, and is unreachable.
- Issue #5: six ported, validated capabilities with no production caller.

Expect this family to keep recurring for as long as "correct" and "matches the oracle" are
different answers with no recorded way to choose between them.

## Options

**A — The oracle is always right; correctness waits.** Divergence is never allowed. A wrong
reference is fixed in `src/sim/` first, always, even for a Swift-only concern. Simplest rule,
strongest guarantee, and it means the shipped game stays wrong until someone edits a frozen
codebase.

**B — Divergence is allowed, and it must be declared.** A `Divergences.swift` (or a section
in `AGENTS.md`) lists every deliberate mismatch: the constant, both values, the reason, the
date. The differential suite reads that list and *asserts the mismatch is still exactly the
one declared* — so an undeclared divergence fails, and a declared one cannot silently grow.
More machinery; makes the cost visible instead of prohibitive.

**C — Unfreeze the reference for correctness fixes only.** The reference stops being frozen
for bugs, stays frozen for features. Keeps one implementation of the truth; costs a golden
regeneration per fix and reopens a codebase that was deliberately closed.

## Recommendation

**B.** It is the only option under which `LAYOUT_CEILING` gets wired up this month, and the
assertion-on-the-declared-list is what stops "divergence allowed" from decaying into "the two
engines drift". A is honest but leaves known-wrong numbers shipping. C gives up the property
that made freezing valuable.

## Decision

**B. The port may deliberately disagree with the oracle, and every disagreement must be
declared in the registry.** ADR-0001 is unchanged: the reference is still the oracle and
matching it is still the default. What changes is that "correct" now has a route, and the
route has a toll.

The registry is `tools/goldens/divergences.ts`. An entry names **the Swift constant, the
value Swift holds, the value the reference holds, the reason, and the date it was
declared** — and it is a *declaration*, not a suppression: nothing about it makes an
assertion pass that would otherwise fail.

Three rules make the declaration mean something.

1. **A divergence must have a name on the Swift side.** The registry can only police a
   value it can reach through `UltimateSim`'s public API, because ADR-0002 requires the
   same assertions to run inside the shipped app, where there is no source tree to parse.
   A bare literal at a site cannot be declared. Extracting the constant is the price of
   diverging, which is the correct price: the pathology above is exactly a constant that
   had a name and no callers.

2. **Neither side's number is transcribed.** The Swift value is read from the live symbol.
   The reference's value is *scraped out of `src/sim/*.ts`* by the generator against a
   pattern tight enough that editing the surrounding expression stops matching. The human
   types the two values once, into the registry, and `SimChecks/DivergenceTests.swift`
   asserts that the declaration, the live Swift symbol, and the reference's own source all
   agree. Move any of the three and the suite is red. This is deliberate: issue #21 is a
   fixture whose two halves were both typed by a human with nothing asserting they agreed.

3. **Equality with the oracle is asserted by default, not on request.** The same fixture
   carries a scrape of every module-scope numeric constant in `src/sim/AI.ts`, and the
   Swift side binds each of those names to a live symbol and asserts equality
   unconditionally. A reference constant the port does not carry under that name has to be
   classified in `unmirrored` with a reason. So an *undeclared* divergence in a named
   constant is a failure nobody had to think to check for, and a **new** reference constant
   fails until somebody says what the port does with it.

## Consequences

**What every future change now owes.** Making Swift right where the reference is wrong is
four steps rather than an argument: give the number a public name, add a registry entry
with both values and a dated reason, regenerate `divergences.json`, and take whatever
golden failures the divergence causes as the honest cost of it. Skipping the registry is no
longer a shortcut — it is a red suite, because the constant you edited is one of the ones
asserted equal by default.

**A divergence cannot silently grow, and cannot silently close.** The entry pins Swift's
value, the reference's value, and the gap between them. If the reference is later fixed so
the two agree, the entry becomes a claim about code that no longer exists and the suite
says so — stale entries are a failure, not clutter.

**What it costs, and it is not the machinery.** It is the goldens. A Swift-only divergence
cannot be regenerated away: `tools/gen-goldens.ts` runs the *reference*, so a fixture
covering an affected path keeps producing the reference's answer and the port stops
matching it. Divergence therefore buys correctness with differential coverage, one path at
a time, and the registry's real job is to make that trade visible at the moment it is made
rather than six weeks later when somebody is bisecting.

The first entry happened to be cheap — the suite stayed green at `PASS 2250893, 0 failures`
and no fixture file moved, because every check that touches the bid branch is a telemetry
band rather than a trace and the change stayed inside every band. Do not read that as the
rule. It is what a divergence costs when the affected path is covered loosely, and the next
one will not be.

**The residual gap, stated plainly.** Two of them.

- *Only named values are policed.* Roughly forty bare metre literals in the AI (ADR-0004,
  issue #17) are invisible to this suite in both engines. An undeclared divergence in one
  of those is caught only if a golden happens to cover the path — which is the pre-existing
  2.25 M assertions, not something this ADR adds. The registry does not detect divergence;
  it detects *undeclared* divergence among constants that have names, and forces a name
  onto anything you want to diverge deliberately.
- *The scrape happens when somebody regenerates.* A reference edit that is never followed
  by `node --experimental-strip-types tools/gen-goldens.ts divergences` leaves a stale
  fixture, and CI runs no TypeScript at all (issue #15). This is the standing weakness of
  every fixture in this repository, not a new one, but the registry inherits it.

**The first entry, and what wiring it actually found.** `AIMath.LAYOUT_CEILING = 1.10` is
declared against the reference's `1.85` and is now **called**, at
`TeamAIDefence.swift:579` — the height guard on the bid branch. The doc comment's claim was
verified before it was relied on: over three full reference matches, 202,000 evaluations of
the two in-flight branches, `land.y` never exceeded **1.4498**. The reference's guard is
inert exactly as claimed, and 30 % of otherwise-eligible bids arrive above 1.10.

The ADR said there were "three real sites". There is one. The other two —
`land.y > 1.85` at `TeamAIDefence.swift:576` and `land.y > 1.9` at `TeamAIThrow.swift:614`
— are **jump gates**, where the same number plays the opposite role, and both mirror the
reference (`AI.ts:3228`, `AI.ts:2717`) faithfully. The `1.9` is not a typo and not a fourth
value of this constant: `offenceInFlight` is a uniformly looser copy of `defenceInFlight`
(gap `0.15` against `0.1`, reach margin `0.5` against `0.4`, height `1.9` against `1.85`),
and its bid branch has no height guard at all. Wiring `LAYOUT_CEILING` into a jump gate
would not tighten a bid — it would **switch on a branch that has never once executed**, on
about half of all in-flight frames. That is a different change with a different
justification and it is not this one.

## Not up for reconsideration

"Just match the reference and note it in a comment" is what this ADR replaces; a comment is
not a declaration, because nothing runs it. Proposals to let the registry *suppress* a
differential assertion should be declined: an entry records that a mismatch is intended, and
losing the coverage is the cost that keeps the list short.

Related: [ADR-0001](0001-the-typescript-reference-is-the-oracle.md),
[ADR-0002](0002-simchecks-is-a-library.md), issues #3, #4, #5, #21, #22, #24.
