---
title: 'ADR-0007 and issue #24 name three call sites for LAYOUT_CEILING; two of them are JUMP gates where the same number does the opposite job'
severity: 'minor'
---

## Description

ADR-0007, issue #24 and `AIMath.swift`'s own doc comment all say the same thing:

> `LAYOUT_CEILING` has zero references outside its declaration. The three real sites
> still say `1.85` (`TeamAIDefence.swift:576,579`) and `1.9` (`TeamAIThrow.swift:614`).

Read as an instruction — "wire the constant to its three call sites" — that is wrong, and
the way it is wrong is not visible from the line numbers. Only **one** of the three is a
layout ceiling:

| site | expression | what it decides |
|---|---|---|
| `TeamAIDefence.swift:579` | `land.y < 1.85` | the height guard **on the bid** — a layout ceiling |
| `TeamAIDefence.swift:576` | `land.y > 1.85` | **jump** instead of bid |
| `TeamAIThrow.swift:614`   | `land.y > 1.9`  | **jump** instead of bid, offence side |

The two jump gates are the same number in the *opposite* comparison. Lowering them to
`1.10` does not tighten a bid; it switches on a branch that has never once executed.
Measured over three full reference matches (202,438 evaluations of the two in-flight
decision blocks, seeds 11/23/37, fifteen minutes each):

| branch | evaluations | `land.y > 1.10` | `> 1.45` | `> 1.85` | `> 1.9` | max `land.y` |
|---|---|---|---|---|---|---|
| `defenceInFlight` | 81,536 | 42,541 | 0 | 0 | 0 | 1.4493 |
| `offenceInFlight` | 120,398 | 48,126 | 0 | 0 | 0 | 1.4498 |

So the inertness claim is true — `land.y` is clamped to `CATCH_CEILING = 1.45` by
`predictCatchPoint`, and nothing came within 0.4 m of 1.85 — but it cuts both ways. The
*bid* guard being inert means bids happen that should not (30 % of otherwise-eligible bids
arrive above 1.10). The *jump* guard being inert means `.jump` never fires at all, and
"fixing" it with the same constant is a much larger, unmeasured behavioural change wearing
the same one-line diff.

The `1.9` is not a typo and not a fourth value of this constant. `offenceInFlight` is a
uniformly looser copy of `defenceInFlight` — gap `0.15` against `0.1`, reach margin `0.5`
against `0.4`, height `1.9` against `1.85` — and its bid branch carries no height guard at
all. Both mirror `src/sim/AI.ts:2717` and `:3228` exactly.

## Why it cost time

The ADR, the issue and the doc comment agree with each other, so there is nothing in the
prose to be suspicious of. The disagreement is only visible by opening all three sites and
reading the comparison operator — one character, in three files, none of which the task
says to open. A brief that names line numbers reads as a brief that has already checked
them.

## Suggestion

When a write-up names N sites for one constant, **quote the expression, not the line**.
`land.y < 1.85` and `land.y > 1.85` are the same literal and opposite decisions, and the
line number hides exactly that.

The reproduction is in `artifacts/landyprobe.ts`: it patches nothing, it wants two
one-line probes at `src/sim/AI.ts:3228` and `:2717` (shown at the top of the file), and it
plays three full matches through the same driver `tools/goldens/matchdiff.ts` uses.
