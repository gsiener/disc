# Outstanding issues

Everything in [`release-plan.md`](release-plan.md) is done: all four milestones, and all
thirteen gameplay targets. What follows is what is left, and none of it is a feature —
these are findings, most of them discovered while fixing something else.

Each entry says what is wrong, what it costs, and what the evidence is, because on this
project the evidence has repeatedly been the expensive part to rediscover. Before
starting any of them, read [`.agents/friction-log/INDEX.md`](../.agents/friction-log/INDEX.md)
and grep it for the files you are about to touch.

---

## 1. Needs a person, not an agent

**Play it, and say how it feels.** Real touches verify in CI that every control *works*
— eleven XCUITest gestures on every push. Nothing verifies that any of it is *good*.
Specifically unjudged: whether the 0.85 s charge window is learnable without reading
anything; whether the cone ever picks somebody you didn't mean; whether hitstop at
~2–3 per game reads as emphasis or interruption; whether committing a defender feels
like agency or like a button that sometimes works.

Suggested protocol: build to a real iPhone, play three games to 3 at each difficulty.
This is the single largest gap in the project and it is the one thing no agent can close.

---

## 2. The port's remaining soft spots

**The two engines are not the same program from the same seed.** The reference derives
its engine seed through a fork and deals its roster from a *separate* fork at team
overalls [76, 74]; the port seeds directly, deals at 72 for both off a different
archetype order, and forks a wind stream the reference does not have. Seed 11 is a 3–9
game in TypeScript and 8–9 in Swift, played by fourteen different athletes. Consequence:
match-level differential testing can only compare pooled distributions (which
`MatchDiffTests` does — reachability parity, completion %, turnovers per point), never
tick-level identity. Aligning the seeding would unlock true differential replay, the
strongest guard this port could have, and would have caught every integration bug found
so far. The **port** moves to match the reference, not the reverse. Measure the cost
before committing to it: the RNG consumption sites would have to match too.

**Four disagreeing models of how far a player can reach.** `standingSlack` (exact,
sweeps the real flight), `arrivalShortfall` (ratio), `reachShortfall` (kinematic), and
`CatchDecision.catchReach`/`layoutReach` (constants). Not academic: pairing
`bidShortfall` with `arrivalShortfall` produced bids that `standingSlack` scored at
1.07 m of standing slack — a 1.9 m disagreement about a 0.73 m decision — because
`timeToReach` charges a plant in whole seconds and that is most of the number over
0.45 s. The harmful pairing is fixed; reconciling all four is not.

**One catch-height band, not five.** The rules engine refuses a standing catch below
`groundY + 0.20` and lowers that to 0.02 only for a body already prone. Every consumer
hardcodes its own number instead — 1.45, 1.35, 0.12 and 0.85 have all appeared. This
caused the worst bug of the project twice: a friction entry from 6 August diagnosed it
exactly *and proposed the fix*, which was never implemented, and it was rediscovered
from the other end on 9 August at a cost of hours. Add one named constant the others
import, plus the assertion that entry asked for: `predictCatchPoint().y` must essentially
never be below the height the rules will pay a standing catch out at, and the solver's
aim height must be reachable given the release height. Related and still inert:
`land.y < 1.85` on both in-flight bid branches, because `predictCatchPoint` clamps to
`CATCH_CEILING` 1.45 — so a defender will dive under a chest-high huck.

**Six ported, validated capabilities with no production caller.** Verified repo-wide:
`GameState.markerLegal` (mark legality is computed every tick and never consulted),
`stallRemaining`, `currentBrick`, `clearLog` (zero references anywhere, tests included),
`DiscRuntime.setTrail`, `TeamAICutRead.runningCut`. This is the **fifth** time the
pattern has appeared — `drop`/`block`/`pullDropped`, `makeCall`/`resolveCall`,
`TeamAI.commandCut` and timeouts were all found the same way. The port was faithful
about *code* and silent about *reachability*. Decide per item: wire it (`markerLegal`
could feed a force/mark display; `currentBrick` and `stallRemaining` are things a player
would want to see) or delete it. Do not leave them in the middle — a validated function
with no caller reads as working and is not. Worth considering as a durable guard: a
check that fails when a public `UltimateSim` function has assertions and no caller
outside `SimChecks`.

---

## 3. Test-suite health

**The suite takes ten minutes, and six suites are all of it.** Measured:
`stoppage` 290.6 s, `calls` 115.4 s, `matchdiff` 107.6 s, `humandefence` 65.3 s,
`engine` 42.4 s, `humancut` 16.4 s — 621 of 640 seconds. The sixteen component-golden
families, **2.24 M of the 2.25 M assertions**, run in about two seconds. So this is not
"the suite is slow", it is "six match-playing suites are slow and contribute almost no
assertions". Fix with a tier split, not deletion: a fast group an agent runs constantly
and a match group CI always runs. `Harness` already selects suites by name. Do **not**
cut coverage to improve the number — `stoppage` proves timeouts and zone actually fire,
and `calls` caught the 8.3-fouls-per-match regression.

**Swift-side assertion bounds are still missing, and this task must not be scheduled
alongside gameplay work.** It was attempted for six hours while three agents moved the
numbers underneath it, which is a coordination error rather than a hard task. Outstanding
in `EngineTests.swift`: the "worst solver miss" headline is a `Check.note` with no upper
bound anywhere (it could reach 40 m and stay green — and it is the assertion that would
have caught the short-throw bombing regression); `median(long) > 3` asserts the
long-range miss is *at least* 3 m, so a worse solver passes more comfortably; the
completion band is printed but never asserted. Bound the **pooled** figures, not
per-seed ones — five configurations touching no throwing code moved per-seed longest
completions across a 27–35 m range. Current values to bound against, re-measured first:
completion 89.7%, holds 64%, drops 2.4%, calls 3.7/match, laid-out D 1.3/game. Also
independent of bounds: check whether the solver accuracy sweep still derives its release
speed from the lead clock rather than `throwReleaseSpeed`, because if so it has never
swept the throw the engine actually makes, and fixing the sweep is worth more than
tightening a bound on the wrong measurement.

**The touch tests wait on simulation pacing rather than on what they test.**
`MatchDriver.waitToThrow` blocks on `carrier == controlled`, which with no input happens
once per point cycle — so a test's duration is set by how long a possession takes.
Measured on one machine: `ChargeTests` 76.1 s before the minis fix, 66.3 s and 44.6 s
after, against a 90 s CI patience; sevens waits 47–62 s on the same predicate. The minis
fix roughly doubled the headroom without changing the structure, so a slower runner will
keep flirting with the limit. Remove the wait rather than raising the timeout again:
start the point with the disc in hand for tests that only need to throw, or let the
driver hold `autoTeams` until it is ready. **This job is blocking, so its flakiness
blocks pushes.**

---

## 4. Smaller, well-specified

**`Engine.phase` collapses ten rules phases into four**, folding `.check`,
`.turnoverDead` and `.timeout` into `.live`. A human release can therefore be refused
while every public signal says it should work — an agent hit this and had to make its
charge helper retry blindly rather than diagnose. Expose the fine phase, or better,
`canRelease`/`canDefend` booleans mirroring `humanRelease`/`humanDefend`'s own guards.
Small change, disproportionate value: it turns "retry five times and hope" into one
assertion, and it would let the HUD tell the player *why* an input was refused, which
the refusal work had to reconstruct from public state.

**`humanCallCut` and `humanDefend` return `nil` for five and three reasons** with no way
to tell which. The view currently reconstructs the reason, and gets one case wrong as a
result: a tap during the stoppage after a call reads `TOO SOON` instead of `NOT IN PLAY`.
A `CutRefusal` result type belongs in `Play/EngineHuman.swift`.

**Holds are at 64% against a 65–75% target** — essentially met, and the remaining point
or two is probably not worth chasing directly. If it is picked up, note the deep game
gave a little back during the calibration (longest completion ~39 m → ~35 m), so look
there rather than at catch odds.

**Reading the friction log still is not a habit.** The index exists now
(`.agents/friction-log/INDEX.md`, fifty entries, titles and severities on one screen)
and `AGENTS.md` points at it, but the mechanism that has actually worked is the
coordinator pasting relevant entries into an agent's brief. Consider a per-file
breadcrumb — a comment in the file an entry is about, pointing at the entry — so it is
found at the moment of need rather than requiring foresight. The asymmetry is the
argument: writing an entry costs a minute, and not reading one has cost hours twice.

**A third pitch rectangle.** The CI probe reported `rect=62,0,750,349` where local debug
is 750×338 and release 750×382. Probably a different device or runtime on the runner,
but the touch tests assert which rectangle they got, so it is worth knowing which is
which.

---

## Process notes worth keeping

These were all learned by breaking something, and they are in `AGENTS.md` in full:
never run a whole-tree git command in a shared checkout; push the SHA you verified, not
the branch; verify a commit in a detached worktree before trusting it; regenerate
goldens by name; shut the Simulator down and leave no orphaned `swift-frontend`.

One more, learned the hard way and not yet written anywhere else: **a masked CI job is
worse than a red one.** `continue-on-error` on the touch tests reported a compile
failure as success. A red job gets fixed; a green lie does not.
