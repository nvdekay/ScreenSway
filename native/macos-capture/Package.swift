// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ScreenSwayCapture",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "screensway-capture", targets: ["ScreenSwayCapture"]),
    ],
    targets: [
        .executableTarget(name: "ScreenSwayCapture"),
    ]
)

