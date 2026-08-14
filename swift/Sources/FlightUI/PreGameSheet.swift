import SwiftUI
import UltimateSim

/// The three decisions taken before the pull, on one card.
///
/// Until this, the only match setting reachable with a thumb was a pair of format buttons
/// wedged into the scoreboard, and the length of a game was whatever `FieldSpec` had been
/// compiled with — a minis game to seven, which runs twenty to forty minutes. That is not
/// a setting anybody chose; it is a constant that outlived its excuse. `EngineConfig` now
/// takes all three, so all three are asked.
///
/// It is a plate rather than a `.sheet`, for the same reason the pause veil and the
/// result card are: everything the game says over the pitch says it in one visual
/// language, and a UIKit sheet sliding up over a RealityView belongs to a different app.
///
/// The card is deliberately not dismissable before the first match. There is no game
/// running behind it to go back to.
@available(macOS 15.0, iOS 18.0, *)
struct PreGameSheet: View {
    /// A match found on disk, and the two things that can be done about it.
    ///
    /// The sheet is the natural home for this and not merely a convenient one: it is
    /// already the screen that asks "what game do you want to play", and "the one you were
    /// playing" is an answer to that question. It is an offer rather than an interruption
    /// — no modal on launch, no dialog to dismiss before a new game — because a player who
    /// opens the app wanting a fresh match should not have to finish an old one first.
    struct Resume {
        /// The score and how far in, so the offer is about a game rather than about a file.
        let summary: String
        let action: () -> Void
        let discard: () -> Void
    }

    @Binding var setup: MatchSetup

    /// The word on the start button, and whether there is anything to go back to.
    let isRematch: Bool

    /// The saved match on offer, if there is one.
    let resume: Resume?

    /// Why the last saved match was thrown away, if one was.
    ///
    /// Separate from `resume` rather than a field on it, and the separation is the whole
    /// point: a save that failed to restore is *gone*, so there is no offer left to hang
    /// the explanation on, and hanging it there would mean the one message the player
    /// needs disappears at exactly the moment it becomes true.
    let note: String?
    /// Start a match on the current setup.
    let onStart: () -> Void
    /// Show the coach cards again. The one way back to them once the first run is spent.
    let onCoach: () -> Void
    /// Open the throwing practice: a target, the same drag-to-throw gesture, no match
    /// around it. Issue #55 — single-player, no drills or difficulty, so it needs nothing
    /// from this sheet's own settings (format, length, difficulty all describe a *match*)
    /// and lives beside START rather than inside any of the groups above.
    let onPractice: () -> Void
    /// Close without starting anything. Nil before the first match, when there is no
    /// match to close onto.
    let onDismiss: (() -> Void)?

    var body: some View {
        ZStack {
            Color.black.opacity(0.72).ignoresSafeArea()

            VStack(alignment: .leading, spacing: 16) {
                header

                if resume != nil || note != nil { resumeRow }

                group("LENGTH", note: lengthNote) {
                    ForEach(MatchSetup.lengths, id: \.self) { n in
                        choice(
                            label: "TO \(n)", detail: nil,
                            selected: setup.pointsToWin == n
                        ) { setup.pointsToWin = n }
                    }
                }

                group("FORMAT", note: setup.format == .minis ? "37 × 18 m" : "100 × 37 m") {
                    ForEach(MatchSetup.Format.allCases, id: \.self) { f in
                        choice(
                            label: f.label, detail: f.detail, selected: setup.format == f
                        ) { setup.format = f }
                    }
                }

                group("DIFFICULTY", note: setup.difficulty.detail) {
                    ForEach(MatchSetup.Difficulty.allCases, id: \.self) { d in
                        choice(
                            label: d.label, detail: nil, selected: setup.difficulty == d
                        ) { setup.difficulty = d }
                    }
                }

                footer
            }
            .frame(maxWidth: 460)
            .padding(.horizontal, 22)
            .padding(.vertical, 20)
            .background(
                RoundedRectangle(cornerRadius: 14)
                    .fill(.black.opacity(0.82))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14)
                            .strokeBorder(.white.opacity(0.10), lineWidth: 1)))
            .padding(.horizontal, 18)
            // See `CoachOverlay`: START lives at the foot of a centred card, and a
            // floating tab bar was sitting on it.
            .padding(.bottom, 104)
        }
        .contentShape(Rectangle())
        .transition(.opacity)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("ULTIMATE")
                .font(.system(size: 24, weight: .heavy, design: .monospaced))
                .foregroundStyle(.orange)
            Spacer()
            if let onDismiss {
                Button(action: onDismiss) {
                    Text("BACK")
                        .font(.system(size: 12, design: .monospaced).bold())
                        .foregroundStyle(.white.opacity(0.55))
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// The saved match, offered.
    ///
    /// At the top, above the settings, because it is the one control on this card that
    /// makes the settings irrelevant — a resumed match is played on the setup it was
    /// started with, and quietly changing FORMAT underneath a RESUME button would be the
    /// sheet lying about what it does. Green rather than the START button's orange, so the
    /// two primary actions on one card are never mistaken for each other.
    ///
    /// DISCARD is beside it and is not a confirmation dialog. The thing being thrown away
    /// is a game the player already walked out of, and asking twice about it would be
    /// heavier than the thing deserves.
    @ViewBuilder private var resumeRow: some View {
        VStack(alignment: .leading, spacing: 7) {
            if let note {
                Text(note)
                    .font(.system(size: 10, design: .monospaced).bold())
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let resume {
                HStack(spacing: 8) {
                    Button(action: resume.action) {
                        VStack(spacing: 2) {
                            Text("RESUME MATCH")
                                .font(.system(size: 14, design: .monospaced).bold())
                            Text(resume.summary)
                                .font(.system(size: 9, design: .monospaced))
                                .opacity(0.75)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(
                            RoundedRectangle(cornerRadius: 8)
                                .fill(Color(red: 0.5, green: 1, blue: 0.62)))
                        .foregroundStyle(.black)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    Button(action: resume.discard) {
                        Text("DISCARD")
                            .font(.system(size: 11, design: .monospaced).bold())
                            .foregroundStyle(.white.opacity(0.55))
                            .padding(.horizontal, 12).padding(.vertical, 14)
                            .background(
                                RoundedRectangle(cornerRadius: 8)
                                    .strokeBorder(.white.opacity(0.18), lineWidth: 1))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    /// A rough sense of what you are signing up for, because "to 7" means nothing until
    /// you know a point is minutes. The numbers are the measured point length in the
    /// engine's own comments — two and a half to three minutes on minis — scaled for the
    /// bigger pitch, and hedged accordingly.
    private var lengthNote: String {
        let perPoint = setup.format == .minis ? 2.5 : 4.0
        // A game to N takes roughly 2N−1 points: one side has to reach N and the other
        // gets most of the way there.
        let points = Double(setup.pointsToWin) * 2 - 1
        let minutes = Int((points * perPoint).rounded())
        return "≈ \(Swift.max(2, minutes - minutes / 3))–\(minutes) MIN"
    }

    private func group<Content: View>(
        _ title: String, note: String, @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(title)
                    .font(.system(size: 11, design: .monospaced).bold())
                    .foregroundStyle(.white.opacity(0.45))
                Spacer()
                Text(note)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.35))
            }
            HStack(spacing: 8) { content() }
        }
    }

    private func choice(
        label: String, detail: String?, selected: Bool, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Text(label)
                    .font(.system(size: 14, design: .monospaced).bold())
                if let detail {
                    Text(detail)
                        .font(.system(size: 9, design: .monospaced))
                        .opacity(0.7)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(selected ? Color.orange : Color.white.opacity(0.10)))
            .foregroundStyle(selected ? .black : .white.opacity(0.75))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Button(action: onCoach) {
                Text("HOW TO PLAY")
                    .font(.system(size: 12, design: .monospaced).bold())
                    .foregroundStyle(.white.opacity(0.7))
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: 8)
                            .strokeBorder(.white.opacity(0.18), lineWidth: 1))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button(action: onPractice) {
                Text("PRACTICE")
                    .font(.system(size: 12, design: .monospaced).bold())
                    .foregroundStyle(.white.opacity(0.7))
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: 8)
                            .strokeBorder(.white.opacity(0.18), lineWidth: 1))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Spacer(minLength: 0)

            Button(action: onStart) {
                Text(isRematch ? "REMATCH" : "START")
                    .font(.system(size: 15, design: .monospaced).bold())
                    .padding(.horizontal, 28).padding(.vertical, 11)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.orange))
                    .foregroundStyle(.black)
            }
            .buttonStyle(.plain)
        }
        .padding(.top, 4)
    }
}
