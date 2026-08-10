# ADR-0004 — Pitch-relative constants scale; genuinely absolute distances do not

- **Status:** Accepted
- **Date:** recorded 2026-08-10, after the most expensive bug in this project's history

## Context

The game supports more than one format. Sevens is played on a 100 × 37 m pitch; minis — the
**default mode** — is much smaller.

Roughly forty bare metre literals that the AI decides with were never threaded through
`GameFormat`. The consequence was not a cosmetic mismatch: the whole minis pitch fits inside
the flat top of the possession-value curve, so holding the disc to stall 9 was *rational*,
and 56–89 % of possessions ended in a stall-out. The default game mode was unplayable, and
every component that computed those numbers was differed bit-exact and green throughout.

## Decision

**A distance in this codebase is one of two things, and which one must be decided
deliberately at the site.**

1. **Pitch-relative** — a fraction of a pitch wearing a metre's clothes. It scales.
   The mechanism is `Playbook.depthScale` / `widthScale` (`Playbook.swift:330,334`): the
   ratio of this format's dimension to regulation's, which is **exactly `1.0` at
   regulation**, so scaling is bit-identical on the sevens pitch and no golden moves.
   Examples: the under/deep lane boundary (`16 * depthScale`), station positions, cut reach,
   the deep-cut gate.

2. **Genuinely absolute** — a property of a human body or of the air, not of the field.
   It does not scale. Examples: a stride length, an arm's reach, a catch radius, and
   `ThrowSolver.loftRange = 25.0` — twenty-five metres of air is twenty-five metres on any
   pitch.

The test, from `.agents/friction-log/20260810-every-shape-constant`:

> **An absolute distance which is not a stride, a reach or an arm's range is a fraction of a
> pitch wearing a metre's clothes.**

## Consequences

**What it bought.** `Playbook` is the yardstick module in this repository. The fix is
bit-identical at regulation, so it carried no golden churn.

**What is not done.** The rule was applied in `Playbook` and not elsewhere. Person defence
reads no field dimension at all — `grep "pb\."` in `TeamAIDefence.swift` returns three
lines, none in the deciding code — so offence and defence disagree about what "deep" means
by construction (`16 * depthScale` versus a bare `14`, which on minis is behind the end
line). Roughly 18–20 literals remain. See issue #17.

**Where the rule lives is itself the problem.** It is written down in a friction-log entry —
somewhere neither the compiler nor the suite can see it. Issue #18 is the durable fix: shape
properties that hold at both formats, so a violation is a red assertion rather than
something found by reading code one measurement at a time.

**A parameter that reaches half-way is worse than none.** `AIMath.discStakes(_:_:field:)`
takes a `field:`, passes it to `yardsToGoal`, and then divides by a regulation `25`. A caller
reading the signature cannot tell which half is honoured. Prefer an unparameterised function
that is visibly sevens-only over one that advertises awareness it does not have.

Related: issues #17, #18.
