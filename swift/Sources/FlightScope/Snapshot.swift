import FlightUI
import SwiftUI

#if canImport(AppKit)
    import AppKit
#endif

/// Render the flight view to a PNG without opening a window.
///
///     swift run FlightScope --snapshot out.png
///
/// This is small but it is the seed of something the plan explicitly wants to carry
/// across: the reference project's quality methodology is deterministic named tableaux
/// plus a frozen-scene screenshot mode, and that concept is worth more than the puppeteer
/// rigs that implemented it. A renderer you can screenshot from a script is a renderer
/// you can regression-test; one you can only photograph by hand is not.
enum Snapshot {
    @MainActor
    static func run(path: String) -> Never {
        let view =
            FlightView()
            .frame(width: 1100, height: 620)
            .preferredColorScheme(.dark)
            .background(Color.black)

        let renderer = ImageRenderer(content: view)
        renderer.scale = 2

        #if canImport(AppKit)
            guard let image = renderer.nsImage,
                let tiff = image.tiffRepresentation,
                let rep = NSBitmapImageRep(data: tiff),
                let png = rep.representation(using: .png, properties: [:])
            else {
                FileHandle.standardError.write(Data("could not render\n".utf8))
                exit(1)
            }
            do {
                try png.write(to: URL(fileURLWithPath: path))
                print("wrote \(path)")
                exit(0)
            } catch {
                FileHandle.standardError.write(Data("could not write \(path): \(error)\n".utf8))
                exit(1)
            }
        #else
            FileHandle.standardError.write(Data("snapshot needs AppKit\n".utf8))
            exit(1)
        #endif
    }
}
