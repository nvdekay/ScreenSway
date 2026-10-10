import AVFoundation
import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct CaptureSource: Codable {
    let id: String
    let kind: String
    let name: String
    let width: Int
    let height: Int
}

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

private let controlClickWindowMs = 600

final class PointerRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var samples: [PointerSample] = []
    private var shouldStop = false
    private var pausedAt: UInt64?
    private var pausedNanoseconds: UInt64 = 0
    private var stoppedAt: UInt64?
    private let displayBounds: CGRect
    private let pixelScale: Double
    private var startedAt: UInt64 = 0

    /// `captureBounds` is in global display points; samples are stored in video pixels.
    init(captureBounds: CGRect, pixelScale: Double) {
        displayBounds = captureBounds
        self.pixelScale = pixelScale
    }

    func start() -> Task<Void, Never> {
        lock.withLock { startedAt = DispatchTime.now().uptimeNanoseconds }
        return Task.detached(priority: .userInitiated) { [self] in
            var previousPoint = CGPoint(x: -.greatestFiniteMagnitude, y: -.greatestFiniteMagnitude)
            var previousLeft = false
            var previousRight = false
            var lastMoveTimestamp = 0

            while !isStopped() {
                if isPaused() {
                    try? await Task.sleep(for: .milliseconds(20))
                    continue
                }
                autoreleasepool {
                    guard let event = CGEvent(source: nil) else { return }
                    let point = event.location
                    let left = CGEventSource.buttonState(.combinedSessionState, button: .left)
                    let right = CGEventSource.buttonState(.combinedSessionState, button: .right)
                    let timestamp = elapsedMilliseconds()

                    let relativeX = (point.x - displayBounds.minX) * pixelScale
                    let relativeY = (point.y - displayBounds.minY) * pixelScale

                    if left && !previousLeft {
                        append(type: "leftClick", timeMs: timestamp, x: relativeX, y: relativeY)
                    } else if right && !previousRight {
                        append(type: "rightClick", timeMs: timestamp, x: relativeX, y: relativeY)
                    } else if timestamp - lastMoveTimestamp >= 16,
                              hypot(point.x - previousPoint.x, point.y - previousPoint.y) >= 0.5 {
                        append(type: "move", timeMs: timestamp, x: relativeX, y: relativeY)
                        previousPoint = point
                        lastMoveTimestamp = timestamp
                    }

                    previousLeft = left
                    previousRight = right
                }

                try? await Task.sleep(for: .milliseconds(4))
            }
        }
    }

    func stop() {
        lock.withLock {
            let now = DispatchTime.now().uptimeNanoseconds
            dropControlClicks(at: now)
            finishPauseIfNeeded(at: now)
            stoppedAt = now
            shouldStop = true
        }
    }

    func setPaused(_ paused: Bool) {
        lock.withLock {
            let now = stoppedAt ?? DispatchTime.now().uptimeNanoseconds
            if paused, pausedAt == nil {
                dropControlClicks(at: now)
                pausedAt = now
            } else if !paused {
                finishPauseIfNeeded(at: now)
            }
        }
    }

    func snapshot() -> [PointerSample] {
        lock.withLock { samples }
    }

    func durationMilliseconds() -> Int {
        lock.withLock {
            let now = DispatchTime.now().uptimeNanoseconds
            let currentPause = pausedAt.map { now - $0 } ?? 0
            return Int((now - startedAt - pausedNanoseconds - currentPause) / 1_000_000)
        }
    }

    private func isStopped() -> Bool {
        lock.withLock { shouldStop }
    }

    private func isPaused() -> Bool {
        lock.withLock { pausedAt != nil }
    }

    private func elapsedMilliseconds() -> Int {
        lock.withLock {
            Int((DispatchTime.now().uptimeNanoseconds - startedAt - pausedNanoseconds) / 1_000_000)
        }
    }

    /// The click that pressed Pause or Stop in ScreenSway's own controls is not part of the
    /// recorded content and must not trigger a zoom toward controls that are not in the video.
    private func dropControlClicks(at now: UInt64) {
        guard pausedAt == nil else { return }
        let elapsedMs = Int((now - startedAt - pausedNanoseconds) / 1_000_000)
        samples.removeAll { $0.type != "move" && $0.timeMs >= elapsedMs - controlClickWindowMs }
    }

    private func finishPauseIfNeeded(at now: UInt64) {
        guard let pausedAt else { return }
        pausedNanoseconds += now - pausedAt
        self.pausedAt = nil
    }

    private func append(type: String, timeMs: Int, x: Double, y: Double) {
        lock.withLock {
            samples.append(PointerSample(timeMs: timeMs, type: type, x: x, y: y))
        }
    }
}

@available(macOS 15.0, *)
struct RecordingSegment {
    let output: SCRecordingOutput
    let delegate: RecordingDelegate
    let url: URL
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

/// SCShareableContent is an immutable snapshot, safe to hand across the callback boundary.
struct SendableContent: @unchecked Sendable {
    let value: SCShareableContent
}

final class ResumeGate: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false

    func once(_ body: () -> Void) {
        let first = lock.withLock { () -> Bool in
            defer { done = true }
            return !done
        }
        if first { body() }
    }
}

enum CaptureError: LocalizedError {
    case noDisplay
    case sourcesUnavailable
    case unsupportedOS
    case outputMissing
    case exportFailed(String)

    var errorDescription: String? {
        switch self {
        case .noDisplay: "ScreenSway could not find the main display."
        case .sourcesUnavailable: "macOS did not return the list of screens and windows. Please try again."
        case .unsupportedOS: "This capture prototype requires macOS 15 or newer."
        case .outputMissing: "Screen recording finished without creating a video file."
        case .exportFailed(let message): "ScreenSway could not assemble the recording: \(message)"
        }
    }
}

private let maximumEncodedDimension = 3_840.0
private let screenRecordingDeniedMarker = "SCREENSWAY_SCREEN_RECORDING_DENIED"

private func isPermissionDenied(_ error: Error) -> Bool {
    let error = error as NSError
    return error.domain == SCStreamErrorDomain && error.code == SCStreamError.Code.userDeclined.rawValue
}

@main
struct ScreenSwayCapture {
    static func main() async {
        do {
            _ = await MainActor.run { NSApplication.shared }
            let summary = try await run()
            let data = try JSONEncoder.screenSway.encode(summary)
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        } catch {
            // The desktop shell recognizes this marker and guides the user to System Settings.
            let message = isPermissionDenied(error)
                ? screenRecordingDeniedMarker
                : "ScreenSway capture failed: \(error.localizedDescription)"
            FileHandle.standardError.write(Data("\(message)\n".utf8))
            Foundation.exit(1)
        }
    }

    static func run() async throws -> CaptureSummary {
        guard #available(macOS 15.0, *) else { throw CaptureError.unsupportedOS }

        let arguments = CommandLine.arguments
        if arguments.contains("--list-sources") {
            let sources = try await listSources()
            let data = try JSONEncoder.screenSway.encode(sources)
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
            Foundation.exit(0)
        }

        guard let outputIndex = arguments.firstIndex(of: "--output"), outputIndex + 1 < arguments.count else {
            throw CocoaError(.fileNoSuchFile, userInfo: [NSLocalizedDescriptionKey: "Missing --output directory."])
        }

        let duration = arguments.firstIndex(of: "--duration")
            .flatMap { $0 + 1 < arguments.count ? Double(arguments[$0 + 1]) : nil }
            .flatMap { $0 } ?? 14_400
        let controlURL = argument(named: "--control", in: arguments)
            .map { URL(fileURLWithPath: $0) }

        let projectURL = URL(fileURLWithPath: arguments[outputIndex + 1], isDirectory: true)
        let mediaURL = projectURL.appending(path: "media", directoryHint: .isDirectory)
        let metadataURL = projectURL.appending(path: "metadata", directoryHint: .isDirectory)
        let videoURL = mediaURL.appending(path: "screen.mp4")
        let segmentsURL = mediaURL.appending(path: "segments", directoryHint: .isDirectory)
        let pointerEventsURL = metadataURL.appending(path: "pointer-events.json")

        try FileManager.default.createDirectory(at: mediaURL, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: metadataURL, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: segmentsURL, withIntermediateDirectories: true)

        let content = try await shareableContent()
        let sourceKind = argument(named: "--source-kind", in: arguments) ?? "display"
        let sourceID = argument(named: "--source-id", in: arguments)

        let filter: SCContentFilter
        let captureBounds: CGRect

        if sourceKind == "window",
           let sourceID,
           let windowID = UInt32(sourceID),
           let window = content.windows.first(where: { $0.windowID == windowID }) {
            filter = SCContentFilter(desktopIndependentWindow: window)
            captureBounds = window.frame
        } else {
            let requestedDisplayID = sourceID.flatMap(UInt32.init)
            let mainDisplayID = CGMainDisplayID()
            guard let display = content.displays.first(where: { $0.displayID == requestedDisplayID })
                ?? content.displays.first(where: { $0.displayID == mainDisplayID })
                ?? content.displays.first else {
                throw CaptureError.noDisplay
            }
            // Keep ScreenSway's own windows (main window, recording controls) out of the video.
            let excludedProcessID = argument(named: "--exclude-pid", in: arguments).flatMap(Int32.init)
            let excludedApplications = content.applications.filter { $0.processID == excludedProcessID }
            filter = SCContentFilter(display: display, excludingApplications: excludedApplications, exceptingWindows: [])
            captureBounds = CGDisplayBounds(display.displayID)
        }

        // Capture at native pixel density (Retina) instead of points, capped for H.264 encoder limits.
        let nativeScale = Double(filter.pointPixelScale)
        let encoderScale = min(1, maximumEncodedDimension / (max(captureBounds.width, captureBounds.height) * nativeScale))
        let pixelScale = nativeScale * encoderScale
        let captureWidth = max(2, Int((captureBounds.width * pixelScale).rounded()) / 2 * 2)
        let captureHeight = max(2, Int((captureBounds.height * pixelScale).rounded()) / 2 * 2)

        let streamConfiguration = SCStreamConfiguration()
        streamConfiguration.width = captureWidth
        streamConfiguration.height = captureHeight
        streamConfiguration.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        streamConfiguration.queueDepth = 8
        streamConfiguration.showsCursor = false
        streamConfiguration.capturesAudio = false
        streamConfiguration.scalesToFit = true
        streamConfiguration.colorSpaceName = CGColorSpace.sRGB

        let stream = SCStream(filter: filter, configuration: streamConfiguration, delegate: nil)

        let pointerRecorder = PointerRecorder(captureBounds: captureBounds, pixelScale: pixelScale)
        let startedAt = Date()
        var segmentURLs: [URL] = []
        var activeSegment = try makeSegment(index: 1, directory: segmentsURL)
        try stream.addRecordingOutput(activeSegment.output)

        try await stream.startCapture()
        let pointerTask = pointerRecorder.start()
        // Tells the desktop shell that frames are being recorded, so its timer starts in sync.
        FileHandle.standardError.write(Data("SCREENSWAY_READY\n".utf8))
        var isPaused = false
        while Date().timeIntervalSince(startedAt) < duration {
            if let controlURL,
               let command = try? String(contentsOf: controlURL, encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines) {
                if command == "stop" {
                    break
                }
                if command == "pause", !isPaused {
                    pointerRecorder.setPaused(true)
                    try stream.removeRecordingOutput(activeSegment.output)
                    try await activeSegment.delegate.waitUntilFinished()
                    segmentURLs.append(activeSegment.url)
                    isPaused = true
                } else if command == "recording", isPaused {
                    activeSegment = try makeSegment(index: segmentURLs.count + 1, directory: segmentsURL)
                    try stream.addRecordingOutput(activeSegment.output)
                    pointerRecorder.setPaused(false)
                    isPaused = false
                }
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        try await stream.stopCapture()
        pointerRecorder.stop()
        await pointerTask.value
        if !isPaused {
            try await activeSegment.delegate.waitUntilFinished()
            segmentURLs.append(activeSegment.url)
        }

        try await assembleSegments(segmentURLs, at: videoURL)
        try? FileManager.default.removeItem(at: segmentsURL)

        guard FileManager.default.fileExists(atPath: videoURL.path) else {
            throw CaptureError.outputMissing
        }
        // The library shows this instead of decoding the full video for every card.
        await writeThumbnail(of: videoURL, to: mediaURL.appending(path: "thumbnail.jpg"))

        let elapsedMs = pointerRecorder.durationMilliseconds()
        let pointerEvents = pointerRecorder.snapshot()
        try JSONEncoder.screenSway.encode(pointerEvents).write(to: pointerEventsURL, options: .atomic)

        let manifest = ProjectManifest(
            schemaVersion: 1,
            title: projectURL.deletingPathExtension().lastPathComponent,
            createdAt: ISO8601DateFormatter().string(from: startedAt),
            durationMs: elapsedMs,
            canvas: .init(width: captureWidth, height: captureHeight),
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
            width: captureWidth,
            height: captureHeight,
            pointerEvents: pointerEvents
        )
    }

    @available(macOS 15.0, *)
    static func makeSegment(index: Int, directory: URL) throws -> RecordingSegment {
        let url = directory.appending(path: String(format: "part-%03d.mp4", index))
        let configuration = SCRecordingOutputConfiguration()
        configuration.outputURL = url
        configuration.outputFileType = .mp4
        if configuration.availableVideoCodecTypes.contains(.h264) {
            configuration.videoCodecType = .h264
        }
        let delegate = RecordingDelegate()
        return RecordingSegment(
            output: SCRecordingOutput(configuration: configuration, delegate: delegate),
            delegate: delegate,
            url: url
        )
    }

    static func assembleSegments(_ segmentURLs: [URL], at destinationURL: URL) async throws {
        guard let firstURL = segmentURLs.first else { throw CaptureError.outputMissing }
        if segmentURLs.count == 1 {
            try FileManager.default.moveItem(at: firstURL, to: destinationURL)
            return
        }

        let composition = AVMutableComposition()
        guard let compositionTrack = composition.addMutableTrack(
            withMediaType: .video,
            preferredTrackID: kCMPersistentTrackID_Invalid
        ) else {
            throw CaptureError.exportFailed("Could not create the video track.")
        }

        var insertionTime = CMTime.zero
        for segmentURL in segmentURLs {
            let asset = AVURLAsset(url: segmentURL)
            let duration = try await asset.load(.duration)
            guard let sourceTrack = try await asset.loadTracks(withMediaType: .video).first else {
                throw CaptureError.exportFailed("A recorded segment has no video track.")
            }
            try compositionTrack.insertTimeRange(
                CMTimeRange(start: .zero, duration: duration),
                of: sourceTrack,
                at: insertionTime
            )
            insertionTime = CMTimeAdd(insertionTime, duration)
        }

        guard let exporter = AVAssetExportSession(
            asset: composition,
            presetName: AVAssetExportPresetPassthrough
        ) else {
            throw CaptureError.exportFailed("Could not initialize the video exporter.")
        }
        try await exporter.export(to: destinationURL, as: .mp4)
    }

    static func writeThumbnail(of videoURL: URL, to thumbnailURL: URL) async {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: videoURL))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 960, height: 600)
        generator.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 2)
        guard let image = try? await generator.image(at: CMTime(value: 1, timescale: 2)).image,
              let destination = CGImageDestinationCreateWithURL(
                  thumbnailURL as CFURL, UTType.jpeg.identifier as CFString, 1, nil
              ) else { return }
        CGImageDestinationAddImage(
            destination, image, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary
        )
        CGImageDestinationFinalize(destination)
    }

    static func listSources() async throws -> [CaptureSource] {
        let content = try await shareableContent()
        let displays = content.displays.enumerated().map { index, display in
            CaptureSource(
                id: String(display.displayID),
                kind: "display",
                name: "Display \(index + 1)",
                width: display.width,
                height: display.height
            )
        }
        let windows = content.windows
            .filter {
                $0.isOnScreen
                    && !($0.title ?? "").isEmpty
                    && !($0.owningApplication?.applicationName ?? "").isEmpty
                    && $0.frame.width >= 240
                    && $0.frame.height >= 160
            }
            .map { window in
                let appName = window.owningApplication?.applicationName ?? "Application"
                return CaptureSource(
                    id: String(window.windowID),
                    kind: "window",
                    name: "\(appName) — \(window.title ?? "Untitled")",
                    width: Int(window.frame.width),
                    height: Int(window.frame.height)
                )
            }
        return displays + windows
    }

    /// ScreenCaptureKit can drop a request without ever answering (for example when another
    /// process queries it at the same moment), so each attempt is bounded and retried.
    static func shareableContent() async throws -> SCShareableContent {
        for _ in 1...3 {
            if let content = try await shareableContentAttempt(timeout: 4) {
                return content.value
            }
        }
        throw CaptureError.sourcesUnavailable
    }

    static func shareableContentAttempt(timeout: TimeInterval) async throws -> SendableContent? {
        try await withCheckedThrowingContinuation { continuation in
            let gate = ResumeGate()
            SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
                gate.once {
                    if let content {
                        continuation.resume(returning: SendableContent(value: content))
                    } else {
                        continuation.resume(throwing: error ?? CaptureError.sourcesUnavailable)
                    }
                }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                gate.once { continuation.resume(returning: nil) }
            }
        }
    }

    static func argument(named name: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }
}

extension JSONEncoder {
    static var screenSway: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}
