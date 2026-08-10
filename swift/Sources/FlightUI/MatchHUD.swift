import Foundation
import SwiftUI
import UltimateSim

/// The words on top of the pitch.
///
/// Everything in this file is a pure function of the match and a handful of countdowns:
/// nothing here steps the simulation, ends a drag or writes a save. That is what makes it
/// separable from `MatchView.swift`, which owns the match and the thumb, and from
/// `MatchScene.swift`, which owns what is in front of the camera.
///
/// It is one file rather than thirteen scattered members for a reason line count does not
/// capture. **The HUD's failure mode is collision, and a collision is only visible when
/// the colliding things are on the same screen.** Two of them were shipped: the two
/// bottom-pinned plates, `defenceReadout` and `defenceHint`, are laid out at the same
/// 96 pt above the same bottom edge — and the goal is announced twice at once, by
/// `scoreboard` and by `callout`, in the same two words. Both are the sort of thing you
/// see in a second when the two pieces of code are forty lines apart and never when they
/// are eight hundred.
///
/// The rules the pieces here follow, so a fourteenth does not have to rediscover them:
///
///   - **The middle of the screen belongs to the callout**, which fires on goals and
///     turnovers. Anything that fires on *every* throw goes elsewhere — that is why
///     `assistReadout` sits under the scoreboard.
///   - **Padding goes inside an expanding frame, never around it.** A `.padding` wrapped
///     around a `maxHeight: .infinity` frame makes the whole thing taller than its parent,
///     and an overflowing child is centred rather than pinned. That is how the defence
///     plate spent its first screenshot in the middle of the pitch.
///   - **Every plate is `.allowsHitTesting(false)`** unless it is a control. The pitch
///     underneath is the game, and a caption that eats a throw is worse than no caption.
@available(macOS 15.0, iOS 18.0, *)
extension MatchView {

    /// Corner darkening. Cheap, and it does most of the work of making a flat green
    /// rectangle look photographed rather than drawn. Sized from the view rather than a
    /// constant, so it lands in the same place on a phone and on an iPad.
    func vignette(in size: CGSize) -> some View {
        RadialGradient(
            gradient: Gradient(stops: [
                .init(color: .clear, location: 0.42),
                .init(color: .black.opacity(0.14), location: 0.74),
                .init(color: .black.opacity(0.42), location: 1.0),
            ]),
            center: .center, startRadius: 0,
            endRadius: Foundation.hypot(size.width, size.height) * 0.58
        )
        .ignoresSafeArea()
    }

    var scoreboard: some View {
        HStack(spacing: 14) {
            Text("YOU \(match.score[0])")
                .foregroundStyle(Color(red: 0.45, green: 0.72, blue: 1))
            Text("—").foregroundStyle(.white.opacity(0.35))
            Text("\(match.score[1]) THEM")
                .foregroundStyle(Color(red: 1, green: 0.48, blue: 0.42))

            windIndicator

            Spacer()

            // The stall count is the clock that matters, so it is the one that is shown.
            // It only exists while someone is holding, which is also the only time it
            // means anything.
            //
            // A goal is *not* shown here, and used to be. The condition was
            // `match.justScored`, which is the identical condition `callout` draws on —
            // so every goal was announced twice at the same instant, in the same two
            // words, thirty points apart on the screen. Two announcements of one event
            // do not read as emphasis; they read as two events, and the eye spends the
            // moment checking whether the small one and the big one agree. The callout
            // is the shout, and this stays the readout.
            if match.holder != nil {
                Text("STALL \(Int(match.stall))")
                    .foregroundStyle(match.stall > 6 ? .orange : .white.opacity(0.7))
            }

            Text("first to \(match.fieldSpec.target)")
                .foregroundStyle(.white.opacity(0.4))

            // Where the format buttons used to be. They were two of the three match
            // settings, wedged into a scoreboard, and each tap silently binned the point
            // being played; the third setting did not exist at all. All three now live on
            // the pre-game sheet, and this is the door to it — it stops the match on the
            // way in, so nothing is thrown away by looking.
            Button {
                showSetup = true
            } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 13, weight: .bold))
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(RoundedRectangle(cornerRadius: 5).fill(.white.opacity(0.12)))
                    .foregroundStyle(.white.opacity(0.75))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("match settings")
        }
        .font(.system(.subheadline, design: .monospaced).bold())
        .padding(.horizontal, 16)
        .padding(.vertical, 9)
        // A backing plate, because the sky behind the top of the screen is now a dusk
        // gradient rather than near-black and white-on-orange is not a score you can read.
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(.black.opacity(0.45))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(.white.opacity(0.10), lineWidth: 1))
        )
        .padding(.horizontal, 16)
        .padding(.top, 12)
    }

    /// Which way the wind is blowing, and how hard.
    ///
    /// Every match draws its own wind and every huck is bent by it, and until this it was
    /// shown nowhere at all — so a throw that faded out of a receiver's hands read as the
    /// flight model being capricious. It is a small thing on the scoreboard rather than a
    /// banner because it is a standing condition, not an event: you want to be able to
    /// find it, not to be told it.
    ///
    /// The arrow is oriented in the camera's frame, not the world's — see `WindReadout`
    /// for the derivation. An arrow pointing up the screen means the wind is going the
    /// way you are attacking; pointing down means you are throwing into it.
    @ViewBuilder private var windIndicator: some View {
        let speed = WindReadout.speed(match.wind)
        // Under a tenth of a metre per second is not weather, and drawing an arrow for it
        // would be a direction the player could act on that does not exist.
        if speed > 0.1 {
            HStack(spacing: 4) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 11, weight: .black))
                    .rotationEffect(
                        WindReadout.bearing(match.wind, attackDir: match.attackDirection(of: 0)))
                Text(String(format: "%.1f", speed))
            }
            .font(.system(size: 12, design: .monospaced).bold())
            .foregroundStyle(.white.opacity(0.55))
            .padding(.leading, 4)
            .accessibilityLabel("wind \(String(format: "%.1f", speed)) metres per second")
        }
    }

    /// What the aim assist did, for about as long as it takes to see the disc leave.
    ///
    /// Deliberately not in the middle of the screen: the goal and turnover callouts live
    /// there, and this fires on *every* throw. It sits under the scoreboard, on the same
    /// plate treatment, small — it is a read-out you learn to glance at, not a shout.
    @ViewBuilder var assistReadout: some View {
        if let toast = assistToast {
            VStack(spacing: 1) {
                Text(toast.title)
                    .font(.system(size: 15, weight: .heavy, design: .monospaced))
                    .foregroundStyle(toast.color)
                Text(toast.detail)
                    .font(.system(size: 11, design: .monospaced).bold())
                    .foregroundStyle(.white.opacity(0.6))
                // The timing half of the throw, when it is worth mentioning. Silent on
                // the plateau — see `AssistToast.ReleaseLine`.
                if let release = toast.release {
                    Text(release.text)
                        .font(.system(size: 10, design: .monospaced).bold())
                        .foregroundStyle(
                            release.perfect
                                ? Color(red: 0.5, green: 1, blue: 0.62) : .orange.opacity(0.85))
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(.black.opacity(0.5))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .strokeBorder(.white.opacity(0.10), lineWidth: 1)))
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.top, 62)
            .allowsHitTesting(false)
            .transition(.opacity)
        }
    }

    /// The defensive call, and then the bill for it.
    ///
    /// Two states in one place, at the foot of the screen where the thumb is, because they
    /// are two halves of one sentence: *this player is going* → *this player is on the
    /// floor for another 1.4 s*. The first is the order; the second is `§4`'s legible
    /// layout cost, and putting them anywhere but the same spot would make the cost read
    /// as unrelated to the decision that bought it.
    ///
    /// The recovery line outranks the call, because by the time a body is down the order
    /// is history and the only fact left is when you get them back. It is read straight
    /// off `Engine.recovery`, i.e. off locomotion's own countdown, rather than off a timer
    /// started here — a HUD clock that has to agree with a simulation clock is a HUD clock
    /// that will not.
    @ViewBuilder var defenceReadout: some View {
        if let seconds = match.recovery(of: match.controlled) {
            defencePlate(
                title: "DOWN",
                tint: .orange,
                detail: String(format: "BACK UP IN %.1fs", seconds))
        } else if let call = defenceCall {
            defencePlate(
                title: call.title,
                tint: Color(red: 0.45, green: 0.72, blue: 1),
                detail: call.detail)
        }
    }

    private func defencePlate(title: String, tint: Color, detail: String) -> some View {
        VStack(spacing: 1) {
            Text(title)
                .font(.system(size: 15, weight: .heavy, design: .monospaced))
                .foregroundStyle(tint)
            Text(detail)
                .font(.system(size: 11, design: .monospaced).bold())
                .foregroundStyle(.white.opacity(0.6))
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(.black.opacity(0.5))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .strokeBorder(.white.opacity(0.10), lineWidth: 1)))
        // Padding inside the expanding frame, not outside it: a `.padding` wrapped
        // *around* an infinite frame makes the whole thing taller than its parent, and an
        // overflowing child gets centred rather than pinned — which is how this plate
        // spent its first screenshot in the middle of the pitch on top of the turnover
        // callout.
        .padding(.bottom, 96)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .allowsHitTesting(false)
        .transition(.opacity)
    }

    /// The one line that tells a player defence exists.
    ///
    /// Shown only while the other team has the disc, only before anything has been
    /// committed, and only until they have used it — after which it would be a permanent
    /// caption on half of every point. The coach cards teach the tap properly; this is the
    /// prompt at the moment it is usable, which is the only moment a prompt is worth
    /// anything.
    ///
    /// **It also stands down whenever `defenceReadout` is drawing**, because the two
    /// occupy the identical rectangle: same 96 pt above the same bottom edge, same
    /// bottom-aligned infinite frame. It already excluded itself for the readout's
    /// `defenceCall` branch and not for its "DOWN / BACK UP IN x.xs" branch — and that
    /// branch is reachable before the player has ever tapped anything, because our
    /// controlled receiver lays out on their own. A player who had never used defence
    /// could therefore get the prompt printed over the recovery countdown, which is one
    /// plate telling them to tap while another explains why they cannot.
    @ViewBuilder var defenceHint: some View {
        if match.possession != 0, match.holder != nil || match.discInFlight,
            defenceCall == nil, match.recovery(of: match.controlled) == nil,
            match.defensiveCommit == nil, !Prefs.defenceUsed, !match.isOver
        {
            Text("TAP TO ATTACK THE DISC")
                .font(.system(size: 11, design: .monospaced).bold())
                .foregroundStyle(.white.opacity(0.55))
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 7).fill(.black.opacity(0.45)))
                .padding(.bottom, 96)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .allowsHitTesting(false)
        }
    }

    /// What the last tap ordered, on offence.
    ///
    /// It reuses `defencePlate` and it sits in the identical rectangle, which is safe for
    /// exactly the reason the two halves of the tap are safe: `defenceReadout` can only
    /// draw while *they* have the disc and this can only draw while *we* do. In the
    /// gesture's orange rather than defence's blue, matching the ghost on the grass — the
    /// plate and the route are one sentence about one decision, the same argument
    /// `MatchScene.bidMarker` makes for the blue.
    @ViewBuilder var cutReadout: some View {
        if let call = cutCall, match.possession == 0 {
            defencePlate(
                title: call.title,
                tint: Color(red: 1.0, green: 0.55, blue: 0.10),
                detail: call.detail)
        }
    }

    /// The one prompt that says the offence has a control at all, until it has been used
    /// once.
    ///
    /// Same rules as `defenceHint`, including standing down whenever anything else wants
    /// that rectangle: it excludes itself while the cut plate is up (it is about to be
    /// replaced by the answer to itself) and while a drag is in progress, because a player
    /// mid-throw is being told to do something they cannot do with the thumb they are
    /// using.
    @ViewBuilder var cutHint: some View {
        if match.possession == 0, match.holder != nil, match.holder == match.controlled,
            cutCall == nil, drag == nil, !Prefs.cutUsed, !match.isOver,
            match.recovery(of: match.controlled) == nil
        {
            Text("TAP THE SPACE TO SEND A CUTTER")
                .font(.system(size: 11, design: .monospaced).bold())
                .foregroundStyle(.white.opacity(0.55))
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 7).fill(.black.opacity(0.45)))
                .padding(.bottom, 96)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .allowsHitTesting(false)
        }
    }

    /// The paused state. One tap resumes, and until it comes the accumulator is not fed —
    /// see `advance`.
    var pausedOverlay: some View {
        ZStack {
            Color.black.opacity(0.55)
            VStack(spacing: 6) {
                Text("PAUSED")
                    .font(.system(size: 26, weight: .heavy, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.9))
                Text("TAP TO RESUME")
                    .font(.system(size: 13, design: .monospaced).bold())
                    .foregroundStyle(.orange)
            }
        }
        .ignoresSafeArea()
        .contentShape(Rectangle())
        // The tap that ends the pause is also the last chance to throw away anything
        // measured against a moment that is gone: a drag whose `onEnded` never came, and a
        // hitstop frozen part-way through its 0.45 s. `FrameClock.abandon` has already
        // taken both — every paused frame runs it — and `cancelDrag` takes the drag state
        // the clock cannot see. Doing it here as well is what makes the resume path
        // *state* rather than a side effect of the pause path still ticking.
        .onTapGesture {
            paused = false
            cancelDrag()
        }
    }

    /// The match being rebuilt.
    ///
    /// A restore replays the whole game from its first tick, which is fast but not
    /// instant — a long match is a few seconds of arithmetic — and a few seconds of
    /// nothing is indistinguishable from a hang. So it says what it is doing and shows how
    /// far it has got, on the same plate treatment as the pause veil, because it is the
    /// same kind of thing: the pitch, stopped, with a reason.
    ///
    /// The bar is honest. It is `ticks replayed / ticks recorded`, not a timer dressed up
    /// as progress, so it slows down where the simulation does.
    func restoringOverlay(_ progress: Double) -> some View {
        ZStack {
            Color.black.opacity(0.72)
            VStack(spacing: 10) {
                Text("RESTORING MATCH")
                    .font(.system(size: 20, weight: .heavy, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.9))
                Text("REPLAYING \(Int(progress * 100))%")
                    .font(.system(size: 12, design: .monospaced).bold())
                    .foregroundStyle(.orange)
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.16)).frame(width: 180, height: 6)
                    Capsule().fill(Color.orange)
                        .frame(width: Swift.max(2, 180 * progress), height: 6)
                }
                .frame(width: 180, height: 6)
            }
        }
        .ignoresSafeArea()
        // It takes the taps, so a thumb waiting on the bar cannot throw the disc of the
        // match being rebuilt underneath it.
        .contentShape(Rectangle())
        .onTapGesture {}
    }

    /// The two things worth interrupting the pitch for: a point, and the turnover that
    /// prevented one. A goal outranks a turnover — a Callahan is both at once, and the
    /// score is the half worth shouting.
    @ViewBuilder var callout: some View {
        if let team = match.justScored {
            calloutPlate(
                title: team == 0 ? "GOAL" : "THEIR POINT",
                tint: team == 0 ? Color(red: 0.5, green: 1, blue: 0.62) : .orange,
                subtitle: "\(match.score[0]) — \(match.score[1])")
        } else if let flash = turnoverFlash {
            calloutPlate(
                title: flash.text,
                tint: flash.good ? Color(red: 0.5, green: 1, blue: 0.62) : .orange,
                subtitle: flash.good ? "YOUR DISC" : "THEY HAVE IT")
        }
    }

    /// The shared shout. A plate rather than a drop shadow: the first version was 46pt
    /// of unbacked text across the middle of the pitch — it announced the goal and hid
    /// the players who had just scored it.
    private func calloutPlate(title: String, tint: Color, subtitle: String) -> some View {
        VStack(spacing: 3) {
            Text(title)
                .font(.system(size: 30, weight: .heavy, design: .monospaced))
                .foregroundStyle(tint)
            Text(subtitle)
                .font(.system(size: 16, design: .monospaced).bold())
                .foregroundStyle(.white.opacity(0.75))
        }
        .padding(.horizontal, 22).padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(.black.opacity(0.5))
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(.white.opacity(0.10), lineWidth: 1)))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .allowsHitTesting(false)
        .transition(.opacity)
    }

    /// The aim line. Drawn in view space rather than in the scene because it is a
    /// statement about your gesture, not about the world — and because it must be legible
    /// against turf at any camera distance. The world-space half of the answer, the arrow
    /// on the grass, is in `PitchScene`.
    func aimOverlay(_ d: DragState, in size: CGSize) -> some View {
        // Back inside the cancel radius: the whole gesture goes grey and the label stops
        // describing a throw. The line stays drawn rather than vanishing, because the
        // thumb is still down and a gesture that disappears under a finger reads as the
        // game having lost the touch rather than as the throw being off.
        let tint: Color = d.aborted ? .white.opacity(0.55) : .orange
        return ZStack {
            Path { p in
                p.move(to: d.start)
                p.addLine(to: d.current)
            }
            .stroke(.black.opacity(0.45), style: StrokeStyle(lineWidth: 7, lineCap: .round))

            Path { p in
                p.move(to: d.start)
                p.addLine(to: d.current)
            }
            .stroke(
                d.aborted
                    ? LinearGradient(colors: [tint, tint], startPoint: .top, endPoint: .bottom)
                    : LinearGradient(
                        colors: [.orange.opacity(0.25), .orange],
                        startPoint: .top, endPoint: .bottom),
                style: StrokeStyle(
                    lineWidth: 4, lineCap: .round,
                    dash: d.aborted ? [5, 5] : []))

            // The anchor, so it is obvious the throw comes from where you started and not
            // from where your thumb happens to be. It is also the cancel target, so while
            // the drag is aborted it is filled rather than outlined — the one place the
            // player is being told the gesture has a home.
            Circle()
                .strokeBorder(tint.opacity(0.7), lineWidth: 2)
                .background(Circle().fill(d.aborted ? .white.opacity(0.16) : .clear))
                .frame(width: 22, height: 22)
                .position(d.start)

            VStack(spacing: 3) {
                if d.aborted {
                    Text("CANCEL")
                        .font(.system(size: 13, design: .monospaced).bold())
                    Text("RELEASE TO KEEP IT")
                        .font(.system(size: 10, design: .monospaced).bold())
                        .foregroundStyle(.white.opacity(0.55))
                } else {
                    Text("\(d.type.rawValue.uppercased())  \(Int(d.power * 100))%")
                        .font(.system(size: 13, design: .monospaced).bold())
                    // Who the cone select currently means — the same pick the bracket on
                    // the grass is standing under, named here because a jersey number is
                    // readable when the receiver themselves is a few pixels tall.
                    if let r = previewedReceiver,
                        let idx = match.players.firstIndex(where: { $0.id == r })
                    {
                        Text("TO #\(jersey(idx))")
                            .font(.system(size: 11, design: .monospaced).bold())
                            .foregroundStyle(.orange.opacity(0.85))
                    }
                    Capsule()
                        .fill(.orange.opacity(0.25))
                        .frame(width: 74, height: 4)
                        .overlay(alignment: .leading) {
                            Capsule().fill(.orange).frame(width: 74 * d.power, height: 4)
                        }
                    chargeMeter(for: d.type)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 7).fill(.black.opacity(0.7)))
            .foregroundStyle(tint)
            .position(x: d.current.x, y: d.current.y - 34)
        }
        .allowsHitTesting(false)
    }

    /// The charge meter: a bar that fills while you hold, and a bright band you are
    /// trying to let go inside.
    ///
    /// It sits directly under the power bar, is the same width, and is the only other
    /// thing by the thumb — so the two halves of a throw read as one instrument. The band
    /// is drawn from `targetHold` and `targetHalfWidth` live (`ThrowCharge.fullTime` and
    /// `perfectWindow`), which means it *visibly narrows and shifts* when the drag
    /// crosses into a hammer or a blade. That is the lesson: the harder throw is not
    /// merely a different arc, it is a smaller window.
    ///
    /// The bar runs to a little past the end of the grace rather than to `maxHold`. Two
    /// seconds of track would put the band at 42% of it and give three-fifths of the
    /// meter to a region no one should ever be in.
    @ViewBuilder private func chargeMeter(for type: ThrowType) -> some View {
        let charge = ThrowGesture.charge(for: type)
        let span = charge.fullTime + charge.overGrace + 0.25
        let width = 74.0
        let progress = Swift.min(1, meterHold / span)
        let perfect = charge.isPerfect(hold: meterHold)
        let inWindow = charge.inWindow(hold: meterHold)
        let bandX = width * (charge.fullTime - charge.perfectWindow) / span
        let bandW = width * (2 * charge.perfectWindow) / span
        let green = Color(red: 0.5, green: 1, blue: 0.62)
        let fill: Color = perfect ? .white : (inWindow ? green : .orange)

        ZStack(alignment: .leading) {
            Capsule().fill(.white.opacity(0.16)).frame(width: width, height: 6)
            // The window. Always visible, because a target you can only see once you
            // have hit it is not a target you can aim at.
            Capsule()
                .fill(green.opacity(perfect ? 0.95 : 0.5))
                .frame(width: Swift.max(3, bandW), height: 6)
                .offset(x: bandX)
            Capsule().fill(fill).frame(width: width * progress, height: 6)
            // The head, so the exact instant is readable at a glance rather than by
            // judging the end of a bar against a band behind it.
            Capsule()
                .fill(.white)
                .frame(width: 2, height: 10)
                .offset(x: Swift.max(0, width * progress - 1))
        }
        .frame(width: width, height: 10)
        .overlay(alignment: .trailing) {
            if charge.isOvercharged(hold: meterHold) {
                Text("HELD")
                    .font(.system(size: 8, design: .monospaced).bold())
                    .foregroundStyle(.orange)
                    .offset(y: -11)
            }
        }
    }
}
