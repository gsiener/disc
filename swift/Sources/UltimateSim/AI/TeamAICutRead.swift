import Foundation

/// Two read-only windows onto the route state `TeamAIOffence` drives.
///
/// **Why this exists and why it is only a read.** `commandCut` lets something outside the
/// AI *author* a cut; nothing outside the AI could then see whether the cut was run, which
/// makes the command channel unassertable — a check could confirm the order was accepted
/// and not that anybody moved. The four facts a caller needs are all already stored on
/// `Mem`, which is internal because it is scratch the AI rewrites every tick; these hand
/// out the two of them that are *about the field* rather than about the AI's bookkeeping,
/// and hand them out by value.
///
/// Deliberately not a way in. There is no setter here and there never should be:
/// `commandCut` is the one documented entry point and a second one would make the lane
/// invariant unmaintainable.
extension TeamAI {

    /// The route this player is running right now, or nil if they are not running one.
    ///
    /// "Running" means the three states a body is actually executing a route in — the
    /// setup step, the plant, and the break into space. A player who has finished and is
    /// clearing back to the stack is *not* running a route: the lane is already released
    /// (see `tickCutters`' `clear` branch) and the AI is free to offer him another. That
    /// distinction is the whole value of this read — it is what lets a caller ask "is the
    /// cut I called still live?" and get an answer that means something.
    public func runningCut(of id: PlayerId) -> Playbook.CutRoute? {
        guard let rec = mem[id], let cut = rec.cut else { return nil }
        switch rec.cutState {
        case .setup, .plant, .break: return cut
        case .clear, .stack: return nil
        }
    }

    /// Who holds this lane, if anybody. The lane table *is* the anti-clog invariant — two
    /// live cuts may never share one — so it is the one piece of AI bookkeeping worth
    /// exposing: a commanded cut that did not take the lane is a commanded cut the next
    /// AI cut is allowed to run straight through.
    public func laneHolder(_ lane: Playbook.LaneKey) -> PlayerId? {
        liveLanes[lane]
    }
}
