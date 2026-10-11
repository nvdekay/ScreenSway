// swift-tools-version: 6.0
import Foundation
import PackageDescription

/// Embedded in the helper binary: macOS ends a process that asks for speech recognition
/// (or the microphone) without a usage description in its own Info.plist.
let infoPlist = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appendingPathComponent("Sources/ScreenSwayCapture/Info.plist")
    .path

let package = Package(
    name: "ScreenSwayCapture",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "screensway-capture", targets: ["ScreenSwayCapture"]),
    ],
    targets: [
        .executableTarget(
            name: "ScreenSwayCapture",
            exclude: ["Info.plist"],
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", infoPlist]),
            ]
        ),
        .testTarget(name: "ScreenSwayCaptureTests", dependencies: ["ScreenSwayCapture"]),
    ]
)
