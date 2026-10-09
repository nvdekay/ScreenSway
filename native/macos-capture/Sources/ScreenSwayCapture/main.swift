import AVFoundation
import CoreGraphics
import Foundation
import ScreenCaptureKit

struct PointerSample: Codable, Sendable {
    let timeMs: Int
    let type: String
    let x: Double
    let y: Double
}

struct CaptureSummary: Codable {
    let projectPath: String
    let videoPath: String
    let pointerEventsPath: String
    let durationMs: Int
    let width: Int
    let height: Int
    let pointerEvents: [PointerSample]
}

struct ProjectManifest: Codable {
    struct Canvas: Codable {
        let width: Int
        let height: Int
    }

    struct Media: Codable {
        let screen: String
    }

    let schemaVersion: Int
    let title: String
    let createdAt: String
    let durationMs: Int
    let canvas: Canvas
    let media: Media
    let pointerEvents: String
}

final class PointerRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var samples: [PointerSample] = []
    private var shouldStop = false
    private let displayBounds: CGRect
    private let startedAt = DispatchTime.now().uptimeNanoseconds

    init(displayID: CGDirectDisplayID) {
        displayBounds = CGDisplayBounds(displayID)
    }

    func start() -> Task<Void, Never> {
        Task.detached(priority: .userInitiated) { [self] in
            var previousPoint = CGPoint(x: -.greatestFiniteMagnitude, y: -.greatestFiniteMagnitude)
            var previousLeft = false
            var previousRight = false
            var lastMoveTimestamp = 0

            while !isStopped() {
                autoreleasepool {
                    guard let event = CGEvent(source: nil) else { return }
                    let point = event.location
                    let left = CGEventSource.buttonState(.combinedSessionState, button: .left)
                    let right = CGEventSource.buttonState(.combinedSessionState, button: .right)
                    let timestamp = elapsedMilliseconds()

                    let relativeX = point.x - displayBounds.minX
                    let relativeY = point.y - displayBounds.minY

                    if left && !previousLeft {
                        append(type: "leftClick", timeMs: timestamp, x: relativeX, y: relativeY)
                    } else if right && !previousRight {
                        append(type: "rightClick", timeMs: timestamp, x: relativeX, y: relativeY)
                    } else if timestamp - lastMoveTimestamp >= 33,
                              hypot(point.x - previousPoint.x, point.y - previousPoint.y) >= 1.5 {
                        append(type: "move", timeMs: timestamp, x: relativeX, y: relativeY)
                        previousPoint = point
                        lastMoveTimestamp = timestamp
                    }

                    previousLeft = left
                    previousRight = right
                }

                try? await Task.sleep(for: .milliseconds(8))
            }
        }
    }

    func stop() {
        lock.withLock { shouldStop = true }
    }

    func snapshot() -> [PointerSample] {
        lock.withLock { samples }
    }

    private func isStopped() -> Bool {
        lock.withLock { shouldStop }
    }

    private func elapsedMilliseconds() -> Int {
        Int((DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000)
    }

    private func append(type: String, timeMs: Int, x: Double, y: Double) {
        lock.withLock {
            samples.append(PointerSample(timeMs: timeMs, type: type, x: x, y: y))
        }
    }
}

final class RecordingDelegate: NSObject, SCRecordingOutputDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var completion: Result<Void, Error>?
    private var continuation: CheckedContinuation<Void, Error>?

    func waitUntilFinished() async throws {
        try await withCheckedThrowingContinuation { continuation in
            let immediate = lock.withLock { () -> Result<Void, Error>? in
                if let completion { return completion }
                self.continuation = continuation
                return nil
            }
            if let immediate {
                continuation.resume(with: immediate)
            }
        }
    }

    func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {}

    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        finish(.success(()))
    }

    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: any Error) {
        finish(.failure(error))
    }

    private func finish(_ result: Result<Void, Error>) {
        let waiter = lock.withLock { () -> CheckedContinuation<Void, Error>? in
            completion = result
            defer { continuation = nil }
            return continuation
        }
        waiter?.resume(with: result)
    }
}

enum CaptureError: LocalizedError {
    case noDisplay
    case unsupportedOS
    case outputMissing

    var errorDescription: String? {
        switch self {
        case .noDisplay: "ScreenSway could not find the main display."
        case .unsupportedOS: "This capture prototype requires macOS 15 or newer."
        case .outputMissing: "Screen recording finished without creating a video file."
        }
    }
}

@main
struct ScreenSwayCapture {
    static func main() async {
        do {
            let summary = try await run()
            let data = try JSONEncoder.screenSway.encode(summary)
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        } catch {
            FileHandle.standardError.write(Data("ScreenSway capture failed: \(error.localizedDescription)\n".utf8))
            Foundation.exit(1)
        }
    }

    static func run() async throws -> CaptureSummary {
        guard #available(macOS 15.0, *) else { throw CaptureError.unsupportedOS }

        let arguments = CommandLine.arguments
        guard let outputIndex = arguments.firstIndex(of: "--output"), outputIndex + 1 < arguments.count else {
            throw CocoaError(.fileNoSuchFile, userInfo: [NSLocalizedDescriptionKey: "Missing --output directory."])
        }

        let duration = arguments.firstIndex(of: "--duration")
            .flatMap { $0 + 1 < arguments.count ? Double(arguments[$0 + 1]) : nil }
            .flatMap { $0 } ?? 10

        let projectURL = URL(fileURLWithPath: arguments[outputIndex + 1], isDirectory: true)
        let mediaURL = projectURL.appending(path: "media", directoryHint: .isDirectory)
        let metadataURL = projectURL.appending(path: "metadata", directoryHint: .isDirectory)
        let videoURL = mediaURL.appending(path: "screen.mp4")
        let pointerEventsURL = metadataURL.appending(path: "pointer-events.json")

        try FileManager.default.createDirectory(at: mediaURL, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: metadataURL, withIntermediateDirectories: true)

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let mainDisplayID = CGMainDisplayID()
        guard let display = content.displays.first(where: { $0.displayID == mainDisplayID }) ?? content.displays.first else {
            throw CaptureError.noDisplay
        }

        let streamConfiguration = SCStreamConfiguration()
        streamConfiguration.width = display.width
        streamConfiguration.height = display.height
        streamConfiguration.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        streamConfiguration.queueDepth = 5
        streamConfiguration.showsCursor = false
        streamConfiguration.capturesAudio = false

        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let stream = SCStream(filter: filter, configuration: streamConfiguration, delegate: nil)

        let outputConfiguration = SCRecordingOutputConfiguration()
        outputConfiguration.outputURL = videoURL
        outputConfiguration.outputFileType = .mp4
        if outputConfiguration.availableVideoCodecTypes.contains(.h264) {
            outputConfiguration.videoCodecType = .h264
        }

        let delegate = RecordingDelegate()
        let recordingOutput = SCRecordingOutput(configuration: outputConfiguration, delegate: delegate)
        try stream.addRecordingOutput(recordingOutput)

        let pointerRecorder = PointerRecorder(displayID: display.displayID)
        let pointerTask = pointerRecorder.start()
        let startedAt = Date()

        try await stream.startCapture()
        try await Task.sleep(for: .seconds(duration))
        try await stream.stopCapture()
        pointerRecorder.stop()
        await pointerTask.value
        try await delegate.waitUntilFinished()

        guard FileManager.default.fileExists(atPath: videoURL.path) else {
            throw CaptureError.outputMissing
        }

        let elapsedMs = Int(Date().timeIntervalSince(startedAt) * 1_000)
        let pointerEvents = pointerRecorder.snapshot()
        try JSONEncoder.screenSway.encode(pointerEvents).write(to: pointerEventsURL, options: .atomic)

        let manifest = ProjectManifest(
            schemaVersion: 1,
            title: projectURL.deletingPathExtension().lastPathComponent,
            createdAt: ISO8601DateFormatter().string(from: startedAt),
            durationMs: elapsedMs,
            canvas: .init(width: display.width, height: display.height),
            media: .init(screen: "media/screen.mp4"),
            pointerEvents: "metadata/pointer-events.json"
        )
        try JSONEncoder.screenSway.encode(manifest).write(
            to: projectURL.appending(path: "project.json"),
            options: .atomic
        )

        return CaptureSummary(
            projectPath: projectURL.path,
            videoPath: videoURL.path,
            pointerEventsPath: pointerEventsURL.path,
            durationMs: elapsedMs,
            width: display.width,
            height: display.height,
            pointerEvents: pointerEvents
        )
    }
}

extension JSONEncoder {
    static var screenSway: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}
