# Retiring the TypeScript oracle

**Goal:** delete `src/`, `tools/`, `package.json` and the Node toolchain entirely, leaving a
Swift-native specification with demonstrated equivalent coverage.

**Authority:** ADR-0008 already permits this and names the precondition —
"replace the executable oracle with a consciously accepted Swift-native specification
(versioned replay scenarios, invariants, and match-level acceptance cases) and demonstrate
equivalent coverage." This plan is that precondition, made executable.

---

## What deletion actually costs — measured, not guessed

Deleting `src/sim/` today **breaks zero Swift tests.** `Goldens.load` reads committed JSON
out of `Bundle.module` (`Harness.swift:207`); there is no Node in the test path. The 22 golden
files are 15 MB of already-captured reference answers and they keep passing forever.

So this is not a cliff. Four things are actually lost, and each needs a replacement:

| # | What dies with TS | Replacement |
|---|---|---|
| 1 | **Regeneration.** 22 of 43 SimChecks files are golden-backed. Once TS is gone their expected values are frozen bytes that can never be re-derived. | Phase 1 — native spec that constrains *behaviour*, not recorded output |
| 2 | **`reference:reachability`** — a TS tool that audits **Swift** ("every public `UltimateSim` func has a caller outside SimChecks"). Plus `reference:imports` (ADR-0008 enforcement) and `reference:structure` (ADR-0004). | Phase 3 — reimplement in Swift |
| 3 | **The divergence registry.** `divergences.json` + `DivergenceTests` encode *deliberate* TS↔Swift disagreements per ADR-0007 (e.g. `LAYOUT_CEILING` 1.1 vs 1.85). With no TS, "divergence" is meaningless. | Phase 4 — resolve each into a plain Swift constant, reason preserved |
| 4 | **The ability to answer "is this change right, or merely different?"** | Phase 1/2 — invariants that encode *why* a value is right |

Items already safe to drop with no replacement: `test-anim`, `test-audio`, `test-camera`,
`test-input`, `test-holds`, `vite`, `web:*` — these test the legacy Three.js preview, which
ADR-0008 already declares legacy and which ships nothing.

---

## The honest problem with "write the oracle in Swift"

An oracle earns its keep by being an *independent* derivation. A Swift oracle written by
porting from `UltimateSim` inherits `UltimateSim`'s bugs and validates nothing — you would
have two copies of the same opinion. So we are not porting the oracle. We are converting
what the oracle *knows* into a specification that stands on its own:

- **Invariants** — properties true of any correct Ultimate sim, regardless of implementation.
  ("A stall count only advances with a legal marker within 3 m." "No two bodies interpenetrate."
  "Possession changes on exactly the events in Rules.") These are *stronger* than goldens
  because they constrain behaviour we never recorded.
- **Versioned replay scenarios** — a seed plus a scripted input trace plus the box score it
  must produce. This is `matchdiff` promoted from a TS-vs-Swift diff to a Swift-vs-committed-
  expectation regression.
- **Match-level acceptance cases** — the sport-truth assertions: offences score more than
  they turf, zone beats deep in wind, elite rosters beat weak ones. `matchdiff.ts`'s header
  already names the four bugs that only this level catches.

---

## TDD, done honestly

A characterization test written against code that already passes it proves nothing — it
locks in current behaviour including current bugs. So the red-green discipline here is
inverted, and it is the same mechanism as the coverage proof:

> **Every new invariant must first be shown to fail against a deliberately mutated `UltimateSim`.**
> Write the invariant → mutate the Swift source so the invariant *should* break → confirm RED →
> revert the mutation → confirm GREEN.

An invariant that cannot be made to fail is not a test, it is a comment. This is Phase 2's
harness, used from day one of Phase 1 rather than bolted on at the end.

---

## Phase 0 — Freeze and capture (half a day)

Do this while Node still exists; it is unrecoverable afterwards.

1. `npm run reference:goldens` — final full regeneration on the canonical platform
   (`.nvmrc` Node, per the existing CI job) so `coeffs` and `matchdiff` are byte-fresh.
2. `swift run SimTests` green against the fresh bytes. Commit with provenance.
3. **Tag it** — `git tag oracle-final` — so the executable reference is always one checkout
   away even after deletion. ADR-0008's "history is in git" argument applies here.
4. Extract the **historical bug corpus**: the 97 `.agents/friction-log/` entries plus the four
   integration bugs named in `tools/goldens/matchdiff.ts`'s header (strips firing 3× vs 0×,
   the 42% short-throw bomb, unported `throwReleaseSpeed`, the fallback glide integrator).
   Each becomes a row in `swift/Sources/SimChecks/Spec/BugCorpus.swift`: the mutation that
   reproduces it, and which check must catch it.

**Exit:** goldens fresh, tagged, corpus enumerated.

## Phase 1 — Build the native spec, TDD (the bulk — 2–3 weeks)

New target `SimSpec` alongside `SimChecks` — a **library**, not a test target, following `SimChecks`' precedent so the spec runs on device as well as in the terminal (see the note atop `Package.swift`). Work module by module, in the order the golden
families already give you. Per module:

1. Read the golden family and its TS fixture generator to recover *intent* — what question
   was this fixture asking?
2. Write the invariant that answers that question without the recorded bytes.
3. Mutation-check it (red → green, as above).
4. Mark the golden family as superseded.

Suggested order, cheapest first: `rng` → `simmath` → `aimath` → `coeffs`/`throws`/`throwsolver`
(closed-form aero, easiest to state as properties) → `rules` → `gamestate` → `move`/`locomotion`
→ `discruntime`/`flight`/`trycatch`/`catchband` → `playbook`/`teamai` (hardest — behavioural)
→ `matchdiff`/`pull`/`lineup`/`humanrelease` (integration).

**Exit:** every one of the 22 families has a named native replacement.


### The rule per-family mutation testing cannot enforce

A constant declared in family X's module can be value-pinned by family Y's golden. Convert X
to laws and relations, and its own mutation table comes back all red — but the value only
stays pinned until Y is deleted. **The coverage does not vanish at conversion time; it
vanishes at deletion time.**

Found on `aimath`: `CATCH_DEAD 0.25 -> 0.30` survives the converted suite (which asserts
`CATCH_DEAD < CATCH_FLOOR`, a relation that moving the value preserves) while failing
`catchband` and `divergences`, both golden-backed and both going away.

So: **pin exact values, not only relations, for constants a module declares.** A relation is
the right assertion for a law and the wrong one for a tuning value something else depends on.

It is also the reason goldens come out in **one commit at the end**, after Phase 2, rather
than family-by-family as each is converted.

## Phase 1b — Port the behavioural TypeScript suites (2–3 days)

**The plan originally missed these, and they are the load-bearing half.**

`tools/` holds six suites that are not goldens and never were — no recorded values, no
fixtures, just properties measured off positions:

| suite | lines | property assertions |
|---|---|---|
| `test-ai.ts` | 2,008 | 70 |
| `test-game.ts` | 1,799 | 93 |
| `test-disc.ts` | 649 | 84 |
| `test-locomotion.ts` | 789 | 52 |
| `test-rules.ts` | 979 | 45 |
| `test-move.ts` | 650 | 33 |
| | **6,874** | **377** |

They assert things like the offence reading as a column (RMS perpendicular residual ≤ 2.0 m),
lane occupancy ≤ 0.45, a reset handler stationed behind the disc ≥ 90% of settled frames,
the mark positionally break-side ≥ 95%, zero out-of-bounds ticks, nobody oscillating in
place, and stamina staying inside a band. That is *already* the golden-free behavioural
specification this whole plan is trying to write, and `git rm -r tools/` deletes it.

The friction log for issue #57 makes the case: three of four candidate fixes were rejected on
this suite's evidence, and `teamai.json` played no diagnostic role — it was regenerated
afterwards. The goldens record what the AI did; these suites state what the AI must do.

Note they are **not wired into `npm test` or CI** — they are run by hand. Porting them to
Swift and putting them in `SimChecks` is therefore a coverage *increase*, not a like-for-like
move, and it should land **before** anything is deleted.

Expect one round of threshold re-measurement: the Swift port rolls its own dice, so a bound
measured on the reference may sit differently. Budget that rather than discovering it.

## Phase 2 — Prove equivalent coverage (3–4 days)

The gate that makes deletion defensible rather than hopeful.

1. Build a mutation runner over `UltimateSim` — constant perturbation, comparison flips,
   dropped guard clauses, skipped calls.
2. For each mutant, run **goldens-only** and **spec-only**. Every mutant the goldens kill,
   the spec must also kill. Any survivor is a spec gap — go back to Phase 1.
3. Replay the Phase 0 bug corpus: each historical bug's mutation must be caught.
4. Publish the kill-rate table. **This table is the "demonstrate equivalent coverage" artifact
   ADR-0008 asks for.**

**Exit:** spec kill-rate ≥ goldens kill-rate, corpus fully caught.

## Phase 3 — Reimplement the CI gates in Swift (2 days)

- `reference:reachability` → a Swift plugin or `swift-syntax` tool. **This one audits Swift and
  is a genuine quality gate; losing it silently is the real risk in this whole plan.**
- `reference:imports` (ADR-0008) → moot once `src/` is gone; delete with the ADR supersession.
- `reference:structure` (ADR-0004, "a field question cannot be asked without a field") → port to
  Swift; ADR-0004 still binds `Playbook.swift`, which already threads the pitch as a value.
- `gate`/`tsc` → moot.
- Rewrite `ci.yml`: drop `setup-node`, `npm ci`, and the two golden-freshness jobs.

## Phase 4 — Dissolve the divergence registry (1 day)

`divergences.json` declares exactly one divergence (`LAYOUT_CEILING`, Swift 1.1 vs reference
1.85) plus three scraped constant tables. The Swift value simply becomes the value.

Each constant is then documented **on its own terms** — why 1.1 m is the reach ceiling of a
prone body — and *not* as a comparison against a reference that no longer exists. A comment
saying "the reference guards this at 1.85" is a dangling pointer the moment `src/` is deleted.

`DivergenceTests` is deleted. ADR-0007 is superseded: with no oracle, "correct" and "matches
the oracle" cannot disagree.

## Phase 5 — Sweep the dangling references (2–3 days)

**587 references across 89 files** in `swift/Sources/` name the TypeScript that is going away —
`Game.ts`, `AI.ts`, `src/sim`, "the reference", "the oracle", `gen-goldens`:

| target | files |
|---|---|
| `SimChecks` | 49 |
| `UltimateSim` | 38 |
| `FlightUI` | 1 |

Most of `SimChecks`' go away with the goldens. `UltimateSim`'s 38 files are the real work,
and they are not mechanical: many carry genuine design rationale wrapped in oracle framing.
The rule for each is —

- **Rationale that stands alone** (why a pull is flattened into a headwind; why `GameState`
  owns the score and `Engine` does not) → keep, restated without the reference.
- **Provenance** ("ported from `AI.ts:1443`", "differed bit-exact against `teamai.json`") → delete.
- **Historical narrative** ("this file's header used to say…", "forgetting this line is #55") →
  delete. Git has it.

This phase is why "clean" is a deliverable and not a nicety: 587 pointers into a deleted tree
is worse than no comments at all, because each one reads as verifiable and is not.

## Phase 6 — Delete (half a day)

```
git rm -r src/ tools/ package.json package-lock.json tsconfig*.json vite.config.* .nvmrc
git rm -r swift/Sources/SimChecks/Goldens/
git rm .github/workflows/pages.yml
```

The goldens go **in the same commit**, not held back a release. There are no users and no
compatibility surface; a frozen fixture with no regeneration path is precisely the "spec
costume" this plan exists to avoid, and keeping it would mean shipping 15 MB of numbers
nobody can re-derive or explain. Drop `resources: [.copy("Goldens")]` from `Package.swift`.

New ADR-0009, *The specification is Swift-native*, superseding 0001, 0007 and 0008. Update
`AGENTS.md` — the TS-first ordering in ADR-0001 is the thing that actually dies here.

---

## Risks

- **`teamai.json` is 6.3 MB of behavioural fixtures and the hardest thing here.** Under the
  no-frozen-goldens constraint there is no fallback: either the AI's behaviour can be stated
  as invariants, or that coverage is genuinely lost. **This is the one place where "clean" and
  "covered" can actually conflict, and it should be decided deliberately rather than
  discovered in Phase 6.** Recommend attacking `teamai` early, out of cheapest-first order, so
  the answer is known before the deletion is irreversible in spirit.
- **Sequencing.** Do not start Phase 1 mid-gameplay-change. Issue #57 landed through the
  TS-first loop; that loop stays usable until Phase 2 passes.
- **Blocked on #59.** A mutation kill-rate measured on a sim that plays differently in debug
  and release is not evidence. Phase 0 does not exit until `SimTests` is green in both.
- **Honest fallback.** If Phase 2's kill-rate lands materially below the goldens', stop and
  say so. The bar does not move to fit the schedule.
