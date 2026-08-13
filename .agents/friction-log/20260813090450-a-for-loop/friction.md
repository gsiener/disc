---
title: 'A for-loop computing frame timestamps as Double(i) * tickDt drifts by a whole tick over thousands of frames'
severity: 'minor'
---

## What happened

Writing `SimChecks/TickLoopTests.swift` (issue #16 Phase 0), I drove a
`FrameClock` + `Engine` pair through several thousand steady frames to reach a
target tick count, computing each frame's wall-clock timestamp independently as
`Double(i) * FrameClock.tickDt` for `i` in `1...7446`. The intent was "one tick
a frame, forever", asserted with `Check.eq(d.tickCount, approach, ...)`.

It failed: `got 7445, want 7446`. One frame among the 7446 bought zero ticks
instead of one, and the deferred tick was still sitting in the accumulator
(under one `tickDt`), not yet fired — it would have landed on frame 7447, which
the loop never reached. The failure cascaded into a second assertion downstream
that assumed the tick position was exact.

The mechanism: `FrameClock.beginFrame` computes `wallDt = now - last`, where
`now` and `last` are each independently rounded products (`i * tickDt` and
`(i-1) * tickDt`). The two are close in magnitude, so the subtraction's
rounding error is tiny in absolute terms — but it only takes one frame, out of
thousands, landing a few ULPs under the tick boundary instead of at or above
it, to buy zero ticks that frame and defer the debt past the end of a loop that
assumed every frame buys exactly one.

`ClockTests.fixedStepAndClamp` already knows about this shape of drift for its
own long steady runs (3600 frames at 60 Hz) and uses `Check.inRange(steadyTicks,
7198, 7200, ...)` rather than exact equality — but that convention is easy to
miss when writing a *new* long steady sequence, because a short run (dozens of
frames) genuinely is exact, and the failure only shows up once the frame count
gets large enough for one boundary case to occur.

## What would help

A comment on `FrameClock.beginFrame` or `ClockTests.fixedStepAndClamp` stating
the rule directly: "a steady loop of N raw `Double(i) * tickDt` timestamps is
only exactly N ticks for small N; past a few hundred frames, assert a range
(±1–2), not equality." Or a small test helper in `SimChecks` — a
`runSteady(_:to:now:)`-style function that advances by mutating `now` with
cumulative `+= tickDt` inside a `while tickCount < target` loop — which sidesteps
the issue entirely, since a steady frame can never buy more than one tick (the
accumulator is always fully drained), so the loop cannot overshoot `target` and
the tick count it lands on is exact by construction rather than by hoped-for
floating-point luck. `TickLoopTests.swift` ended up writing exactly this helper
after hitting the failure; it would be worth promoting into shared test
infrastructure the next time two suites need it.

## Workaround used

Rewrote the affected assertions in `TickLoopTests.swift` to use a
`while d.tickCount < target { now += tickDt; d.advance(...) }` loop instead of
a `for i in 1...N { now = Double(i) * tickDt; ... }` one, and loosened a couple
of downstream multi-frame sums to `Check.inRange` per the existing `ClockTests`
convention.
