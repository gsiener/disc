# Architecture decision records

Decisions here are **load-bearing and already made** — recorded so that a review, a new
agent, or a future reader does not re-litigate them. Each one says what it bought, what it
cost, and what is *not* up for reconsideration.

The first six were written on 2026-08-10, well after the decisions themselves, from evidence
in the code and in `.agents/friction-log/`. Where an ADR names something as unenforced or
unfinished, that is a gap in *carrying out* the decision, not a reason to revisit it.

| # | Decision | Status |
|---|---|---|
| [0001](0001-the-typescript-reference-is-the-oracle.md) | The TypeScript reference is the oracle, and it evolves first | Accepted |
| [0002](0002-simchecks-is-a-library.md) | `SimChecks` is a library, not an XCTest target | Accepted |
| [0003](0003-a-fixed-tick-and-dt-is-part-of-the-input.md) | A fixed 1/120 s tick, and the `dt` sequence is part of the input | Accepted |
| [0004](0004-pitch-relative-constants-scale.md) | Pitch-relative constants scale; genuinely absolute distances do not | Accepted |
| [0005](0005-ci-never-cancels-on-main.md) | CI never cancels in-progress runs on `main` | Accepted |
| [0006](0006-the-xcode-project-is-generated.md) | The Xcode project is generated from `ios/project.yml` | Accepted |
| [0007](0007-when-correct-and-matching-the-oracle-disagree.md) | When "correct" and "matches the oracle" disagree | Accepted |

## Writing a new one

Add one when a decision would otherwise have to be re-derived from the code, or when a
proposal is declined for a reason a future reader would need in order not to re-suggest it.
Number sequentially. Keep the sections: Status, Context, Decision, Consequences — and say
what it cost, not only what it bought.

Reasons that are ephemeral ("not worth it right now") or self-evident do not need an ADR.
