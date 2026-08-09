import SwiftUI
import UltimateSim

/// The three sentences the game cannot be played without.
///
/// Everything else here is discoverable — you find out what a stall count is by watching
/// one run out — but the control scheme is not: it is one drag that encodes direction,
/// power, throw type *and* receiver, and nothing on screen says so. A player who is never
/// told reads their first five throws as the game misunderstanding them.
///
/// So: three cards, in the order you need them, shown once and replayable from the
/// pre-game sheet. Nothing is animated in from the side and nothing is timed, because the
/// match behind this is paused (see `MatchView.running`) and the only cost of reading is
/// reading.
///
/// **The second card is the one that has to stay true.** It states the throw table from
/// `ThrowGesture.interpret`, whose thresholds are on `rise` — the drag's vertical
/// component over its length, positive up the screen: below −0.25 is a push, −0.25 to
/// 0.25 is flat (forehand right, backhand left), 0.25 to 0.55 is a blade and 0.55 up is a
/// hammer. If that switch ever moves, this card is wrong and the game lies to new
/// players; the thresholds are named here rather than restated as prose so the drift is
/// at least visible in a diff.
@available(macOS 15.0, iOS 18.0, *)
struct CoachOverlay: View {
    /// Called when the player is done — by skipping or by reaching the end. The caller
    /// decides what that means for the "seen" flag.
    let onDone: () -> Void

    @State private var page = 0

    private static let pages = 3

    var body: some View {
        ZStack {
            // Darker than the pause veil. This is the only thing on screen worth
            // reading, and a pitch showing through it competes with the words.
            Color.black.opacity(0.72).ignoresSafeArea()

            VStack(spacing: 0) {
                header
                card
                footer
            }
            .frame(maxWidth: 460)
            .padding(.horizontal, 22)
            .padding(.vertical, 18)
            .background(
                RoundedRectangle(cornerRadius: 14)
                    .fill(.black.opacity(0.82))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14)
                            .strokeBorder(.white.opacity(0.10), lineWidth: 1)))
            .padding(.horizontal, 18)
            // Clear of the bottom of the screen. The card is centred and its buttons are
            // at its foot, which in a debug build put PLAY underneath the floating tab
            // bar — the one control on the card you have to be able to hit.
            .padding(.bottom, 104)
        }
        // Takes every tap, which is the point: a coach card that let a drag through to
        // the pitch would teach the gesture by throwing with it.
        .contentShape(Rectangle())
        .transition(.opacity)
    }

    // MARK: chrome

    private var header: some View {
        HStack {
            Text("HOW TO PLAY")
                .font(.system(size: 12, design: .monospaced).bold())
                .foregroundStyle(.white.opacity(0.45))
            Spacer()
            Button(action: onDone) {
                Text("SKIP")
                    .font(.system(size: 12, design: .monospaced).bold())
                    .foregroundStyle(.white.opacity(0.55))
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.bottom, 12)
    }

    @ViewBuilder private var card: some View {
        switch page {
        case 0: lesson(title: "DRAG TO THROW", body: dragLesson)
        case 1: lesson(title: "FINISH HIGH OR LOW", body: typeLesson)
        default: lesson(title: "AIM AT A TEAM-MATE", body: coneLesson)
        }
    }

    private func lesson<Body: View>(title: String, @ViewBuilder body: () -> Body) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.system(size: 22, weight: .heavy, design: .monospaced))
                .foregroundStyle(.orange)
            body()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var footer: some View {
        HStack(spacing: 10) {
            ForEach(0..<Self.pages, id: \.self) { i in
                Circle()
                    .fill(i == page ? Color.orange : Color.white.opacity(0.22))
                    .frame(width: 6, height: 6)
            }
            Spacer()
            Button {
                if page + 1 < Self.pages { page += 1 } else { onDone() }
            } label: {
                Text(page + 1 < Self.pages ? "NEXT" : "PLAY")
                    .font(.system(size: 14, design: .monospaced).bold())
                    .padding(.horizontal, 22).padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.orange))
                    .foregroundStyle(.black)
            }
            .buttonStyle(.plain)
        }
        .padding(.top, 16)
    }

    // MARK: the three lessons

    @ViewBuilder private func dragLesson() -> some View {
        line("Press on the pitch and drag. Where you drag is where the disc goes.")
        line("How far you drag is how hard you throw — the bar by your thumb is the power.")
        DragDiagram()
            .frame(height: 92)
            .padding(.vertical, 2)
        note("Drag back onto your starting point to call it off. The line greys out and reads CANCEL.")
    }

    @ViewBuilder private func typeLesson() -> some View {
        line("The height you finish at picks the throw, because that is what a throw is for.")
        VStack(spacing: 6) {
            throwRow("↓", "DUMP", "back towards yourself, when the count is up")
            throwRow("→", "FOREHAND", "flat and to the right")
            throwRow("←", "BACKHAND", "flat and to the left")
            throwRow("↗", "BLADE", "up a little — over a low mark")
            throwRow("↑", "HAMMER", "steeply up — over the top of everything")
        }
        .padding(.top, 2)
    }

    @ViewBuilder private func coneLesson() -> some View {
        line("You do not pick a receiver from a list. You point at one.")
        line(
            "While you drag, a bracket lights up under the team-mate inside your aim cone, and their number shows by your thumb. That is who the disc is going to."
        )
        ConeDiagram()
            .frame(height: 96)
            .padding(.vertical, 2)
        note("Point at nobody and it is an open throw — the disc goes exactly where you aimed.")
    }

    // MARK: pieces

    private func line(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 14, design: .monospaced))
            .foregroundStyle(.white.opacity(0.82))
            .fixedSize(horizontal: false, vertical: true)
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(.white.opacity(0.5))
            .fixedSize(horizontal: false, vertical: true)
    }

    private func throwRow(_ arrow: String, _ name: String, _ detail: String) -> some View {
        HStack(spacing: 10) {
            Text(arrow)
                .font(.system(size: 16, weight: .heavy, design: .monospaced))
                .foregroundStyle(.orange)
                .frame(width: 20)
            Text(name)
                .font(.system(size: 13, design: .monospaced).bold())
                .foregroundStyle(.white.opacity(0.9))
                .frame(width: 96, alignment: .leading)
            Text(detail)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.white.opacity(0.5))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }
}

// MARK: - diagrams

/// A thumb, a drag, and the power bar it fills. The same orange line the real gesture
/// draws, at rest, so the card and the pitch are visibly the same object.
@available(macOS 15.0, iOS 18.0, *)
private struct DragDiagram: View {
    var body: some View {
        GeometryReader { geo in
            let start = CGPoint(x: geo.size.width * 0.18, y: geo.size.height * 0.78)
            let end = CGPoint(x: geo.size.width * 0.62, y: geo.size.height * 0.24)
            ZStack {
                Path { p in
                    p.move(to: start)
                    p.addLine(to: end)
                }
                .stroke(
                    LinearGradient(
                        colors: [.orange.opacity(0.25), .orange],
                        startPoint: .bottom, endPoint: .top),
                    style: StrokeStyle(lineWidth: 4, lineCap: .round))

                Circle()
                    .strokeBorder(.orange.opacity(0.7), lineWidth: 2)
                    .frame(width: 22, height: 22)
                    .position(start)

                VStack(spacing: 3) {
                    Text("FOREHAND  62%")
                        .font(.system(size: 11, design: .monospaced).bold())
                    Capsule()
                        .fill(.orange.opacity(0.25))
                        .frame(width: 74, height: 4)
                        .overlay(alignment: .leading) {
                            Capsule().fill(.orange).frame(width: 74 * 0.62, height: 4)
                        }
                }
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 7).fill(.black.opacity(0.7)))
                .foregroundStyle(.orange)
                .position(x: Swift.min(end.x + 40, geo.size.width - 56), y: end.y)
            }
        }
    }
}

/// Two team-mates, one of them inside the cone and wearing the bracket. The bracket is
/// four corner dashes here for the same reason it is four corner dashes on the grass.
@available(macOS 15.0, iOS 18.0, *)
private struct ConeDiagram: View {
    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            let thrower = CGPoint(x: w * 0.14, y: h * 0.78)
            let picked = CGPoint(x: w * 0.62, y: h * 0.26)
            let other = CGPoint(x: w * 0.86, y: h * 0.72)
            ZStack {
                // The cone itself, as the wedge it is.
                Path { p in
                    p.move(to: thrower)
                    p.addLine(to: CGPoint(x: w * 0.52, y: 0))
                    p.addLine(to: CGPoint(x: w * 0.92, y: h * 0.30))
                    p.closeSubpath()
                }
                .fill(.orange.opacity(0.12))

                marker(at: picked, bracketed: true)
                marker(at: other, bracketed: false)

                Circle()
                    .fill(.white.opacity(0.85))
                    .frame(width: 9, height: 9)
                    .position(thrower)
                Text("YOU")
                    .font(.system(size: 9, design: .monospaced).bold())
                    .foregroundStyle(.white.opacity(0.5))
                    .position(x: thrower.x, y: thrower.y + 14)
            }
        }
    }

    private func marker(at point: CGPoint, bracketed: Bool) -> some View {
        ZStack {
            Circle()
                .fill(Color(red: 0.45, green: 0.72, blue: 1).opacity(bracketed ? 0.95 : 0.45))
                .frame(width: 10, height: 10)
            if bracketed {
                ForEach(0..<4, id: \.self) { i in
                    let theta = (Double(i) + 0.5) / 4 * 2 * .pi
                    Capsule()
                        .fill(Color.orange)
                        .frame(width: 9, height: 3)
                        .rotationEffect(.radians(theta))
                        .offset(x: 15 * Foundation.sin(theta), y: -15 * Foundation.cos(theta))
                }
                Text("#7")
                    .font(.system(size: 10, design: .monospaced).bold())
                    .foregroundStyle(.orange)
                    .offset(x: 30, y: -2)
            }
        }
        .position(point)
    }
}
