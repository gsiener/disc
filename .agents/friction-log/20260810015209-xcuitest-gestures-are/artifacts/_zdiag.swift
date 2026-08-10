// Drop this into ios/UltimateUITests, run `xcodegen generate`, then:
//
//   xcodebuild test -project Ultimate.xcodeproj -scheme UltimateUITests \
//     -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
//     -only-testing:UltimateUITests/ZDiag CODE_SIGNING_ALLOWED=NO
//
// It prints one ZDIAG line per change in possession / holder / cut legality, which is how the
// "possession alternates every ten seconds and nobody scores" reading in possession-trace.txt
// was taken. It is also the fastest way to see what the state probe says at any moment — the
// same string `MatchDriver.probe()` parses.
import XCTest

final class ZDiag: XCTestCase {
    func testWatchPossession() {
        let app = XCUIApplication()
        app.launchArguments = ["-setup", "off", "-probe", "on", "-points", "9"]
        app.launch()
        let skip = app.buttons["coach.skip"]
        if skip.waitForExistence(timeout: 3) { skip.tap() }
        let probe = app.descendants(matching: .any).matching(identifier: "match.probe").firstMatch
        _ = probe.waitForExistence(timeout: 10)
        let t0 = Date()
        var last = ""
        while Date().timeIntervalSince(t0) < 150 {
            let key = probe.label.split(separator: ";").filter {
                $0.hasPrefix("poss=") || $0.hasPrefix("mine=") || $0.hasPrefix("cut.ok=")
                    || $0.hasPrefix("score=") || $0.hasPrefix("flight=")
            }.joined(separator: ";")
            if key != last {
                print("ZDIAG \(String(format: "%6.2f", Date().timeIntervalSince(t0))) \(key)")
                last = key
            }
        }
    }
}
