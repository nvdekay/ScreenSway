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
    /// Pixels per point: 2 on Retina displays, 1 on standard ones. Recordings of standard
    /// displays hold half the detail, which shows once the preview zooms in.
    let pixelScale: Double
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

    /// `startTime` is an uptime timestamp shared with the video writer so both timelines start together.
    func start(at startTime: UInt64) -> Task<Void, Never> {
        lock.withLock { startedAt = startTime }
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

    func stop(at now: UInt64) {
        lock.withLock {
            dropControlClicks(at: now)
            finishPauseIfNeeded(at: now)
            stoppedAt = now
            shouldStop = true
        }
    }

    func setPaused(_ paused: Bool, at time: UInt64) {
        lock.withLock {
            let now = stoppedAt ?? time
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
            // Measure up to the stop command, not to when the video finished writing.
            let now = stoppedAt ?? DispatchTime.now().uptimeNanoseconds
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

/// Encodes ScreenCaptureKit frames with explicit quality settings. SCRecordingOutput picks
/// its own (low) bitrate, which made text blocky, especially once the preview zooms in.
///
/// Timestamps are rebased so the video starts at the same instant as the pointer log and
/// paused time is removed directly, without writing and re-assembling separate segments.
final class VideoWriter: NSObject, SCStreamOutput, @unchecked Sendable {
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let lock = NSLock()
    private var sessionStart: CMTime?
    private var pausedAt: CMTime?
    private var pausedTotal = CMTime.zero
    private var lastAppended = CMTime.invalid
    /// ScreenCaptureKit only sends a frame when the screen changes, so the most recent one
    /// is kept to seed the video at start and to refresh it on resume.
    private var latestFrame: CMSampleBuffer?
    private var frameArrivedWhilePaused = false
    private var finished = false

    init(url: URL, width: Int, height: Int) throws {
        writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        // About 0.15 bits per pixel per frame at 60 fps: ~18 Mbps for 1080p, ~53 Mbps for Retina.
        let bitrate = min(80_000_000, max(10_000_000, Double(width * height) * 60 * 0.15))
        input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoExpectedSourceFrameRateKey: 60,
                AVVideoMaxKeyFrameIntervalDurationKey: 2,
            ],
        ])
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else {
            throw CaptureError.exportFailed("The video encoder rejected the capture settings.")
        }
        writer.add(input)
        super.init()
    }

    func start(at hostTime: UInt64) throws {
        try lock.withLock {
            guard writer.startWriting() else {
                throw writer.error ?? CaptureError.exportFailed("The video writer could not start.")
            }
            writer.startSession(atSourceTime: .zero)
            sessionStart = Self.time(hostTime)
            // The first frame often arrives before the writer starts; a static screen may never send another.
            if let latestFrame { append(latestFrame, at: .zero) }
        }
    }

    func setPaused(_ paused: Bool, at hostTime: UInt64) {
        lock.withLock {
            let now = Self.time(hostTime)
            if paused, pausedAt == nil {
                pausedAt = now
            } else if !paused, let pausedAt {
                pausedTotal = pausedTotal + (now - pausedAt)
                self.pausedAt = nil
                // The screen may have changed while paused; show its latest state at once
                // instead of holding the last frame from before the pause.
                if frameArrivedWhilePaused, let latestFrame {
                    append(latestFrame, at: mediaTime(now))
                }
                frameArrivedWhilePaused = false
            }
        }
    }

    func finish(at hostTime: UInt64) async throws {
        let end: CMTime = lock.withLock {
            finished = true
            let now = Self.time(hostTime)
            if let pausedAt {
                pausedTotal = pausedTotal + (now - pausedAt)
                self.pausedAt = nil
            }
            // ScreenCaptureKit only sends frames when the screen changes, so repeat the last
            // frame just before the stop time. endSession alone does not reliably extend a
            // file that holds very few frames, and the video must match the pointer timeline.
            let end = mediaTime(now)
            let closingFrameTime = end - Self.frameDuration
            if let latestFrame, lastAppended.isValid, closingFrameTime > lastAppended {
                waitUntilInputIsReady()
                append(latestFrame, at: closingFrameTime)
            }
            input.markAsFinished()
            return lastAppended.isValid ? CMTimeMaximum(end, lastAppended + Self.frameDuration) : end
        }
        guard lastAppended.isValid else {
            writer.cancelWriting()
            throw CaptureError.outputMissing
        }
        writer.endSession(atSourceTime: end)
        await writer.finishWriting()
        if writer.status != .completed {
            throw writer.error ?? CaptureError.exportFailed("The video file could not be finalized.")
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid, Self.isCompleteFrame(sampleBuffer) else { return }
        lock.withLock {
            guard !finished else { return }
            latestFrame = sampleBuffer
            guard sessionStart != nil else { return }
            if pausedAt != nil {
                frameArrivedWhilePaused = true
                return
            }
            append(sampleBuffer, at: mediaTime(sampleBuffer.presentationTimeStamp))
        }
    }

    /// Must be called with the lock held.
    private func append(_ sampleBuffer: CMSampleBuffer, at requestedTime: CMTime) {
        // The first frame starts the video at zero; later frames must keep moving forward.
        var time = lastAppended.isValid ? requestedTime : .zero
        if lastAppended.isValid, time <= lastAppended {
            time = lastAppended + CMTime(value: 1, timescale: 600)
        }
        guard time >= .zero, input.isReadyForMoreMediaData else { return }

        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: time, decodeTimeStamp: .invalid)
        var retimed: CMSampleBuffer?
        let status = CMSampleBufferCreateCopyWithNewTiming(
            allocator: kCFAllocatorDefault,
            sampleBuffer: sampleBuffer,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleBufferOut: &retimed
        )
        guard status == noErr, let retimed, input.append(retimed) else { return }
        lastAppended = time
    }

    private static let frameDuration = CMTime(value: 1, timescale: 60)

    /// Must be called with the lock held. The encoder can be briefly busy; give it a moment
    /// so the closing frame is not dropped.
    private func waitUntilInputIsReady() {
        for _ in 0..<100 where !input.isReadyForMoreMediaData {
            Thread.sleep(forTimeInterval: 0.002)
        }
    }

    /// Must be called with the lock held.
    private func mediaTime(_ hostTime: CMTime) -> CMTime {
        guard let sessionStart else { return .invalid }
        return hostTime - sessionStart - pausedTotal
    }

    private static func time(_ uptimeNanoseconds: UInt64) -> CMTime {
        CMTime(value: CMTimeValue(uptimeNanoseconds), timescale: 1_000_000_000)
    }

    private static func isCompleteFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
            as? [[SCStreamFrameInfo: Any]],
              let rawStatus = attachments.first?[.status] as? Int,
              let status = SCFrameStatus(rawValue: rawStatus) else { return false }
        return status == .complete
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
        let pointerEventsURL = metadataURL.appending(path: "pointer-events.json")

        try FileManager.default.createDirectory(at: mediaURL, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: metadataURL, withIntermediateDirectories: true)

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
        // Deliver frames in the encoder's native format so they are not converted twice.
        streamConfiguration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        streamConfiguration.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2

        let stream = SCStream(filter: filter, configuration: streamConfiguration, delegate: nil)

        let pointerRecorder = PointerRecorder(captureBounds: captureBounds, pixelScale: pixelScale)
        let videoWriter = try VideoWriter(url: videoURL, width: captureWidth, height: captureHeight)
        let startedAt = Date()
        try stream.addStreamOutput(
            videoWriter,
            type: .screen,
            sampleHandlerQueue: DispatchQueue(label: "app.screensway.capture.video", qos: .userInteractive)
        )

        try await stream.startCapture()
        let recordingStart = DispatchTime.now().uptimeNanoseconds
        try videoWriter.start(at: recordingStart)
        let pointerTask = pointerRecorder.start(at: recordingStart)
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
                    let now = DispatchTime.now().uptimeNanoseconds
                    pointerRecorder.setPaused(true, at: now)
                    videoWriter.setPaused(true, at: now)
                    isPaused = true
                } else if command == "recording", isPaused {
                    let now = DispatchTime.now().uptimeNanoseconds
                    pointerRecorder.setPaused(false, at: now)
                    videoWriter.setPaused(false, at: now)
                    isPaused = false
                }
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        let recordingEnd = DispatchTime.now().uptimeNanoseconds
        pointerRecorder.stop(at: recordingEnd)
        try await stream.stopCapture()
        try await videoWriter.finish(at: recordingEnd)
        await pointerTask.value

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
                height: display.height,
                pixelScale: Double(SCContentFilter(display: display, excludingWindows: []).pointPixelScale)
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
                    height: Int(window.frame.height),
                    pixelScale: Double(SCContentFilter(desktopIndependentWindow: window).pointPixelScale)
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
