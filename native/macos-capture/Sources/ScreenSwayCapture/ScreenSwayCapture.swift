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

struct Microphone: Codable {
    /// The `AVCaptureDevice` unique ID, passed back as `--microphone`.
    let id: String
    let name: String
    let isDefault: Bool
}

struct Camera: Codable {
    let id: String
    let name: String
    let isDefault: Bool
}

struct PointerSample: Codable, Sendable {
    let timeMs: Int
    let type: String
    let x: Double
    let y: Double
}

struct KeystrokeSample: Codable, Sendable {
    let timeMs: Int
    let keys: [String]
}

struct CaptureSummary: Codable {
    let projectPath: String
    let videoPath: String
    let pointerEventsPath: String
    let keystrokesPath: String
    let cameraPath: String?
    let durationMs: Int
    let width: Int
    let height: Int
    let pointerEvents: [PointerSample]
    let keystrokes: [KeystrokeSample]
}

struct ProjectManifest: Codable {
    struct Canvas: Codable {
        let width: Int
        let height: Int
    }

    struct Media: Codable {
        let screen: String
        let camera: String?
    }

    let schemaVersion: Int
    let title: String
    let createdAt: String
    let durationMs: Int
    let canvas: Canvas
    let media: Media
    let pointerEvents: String
    let keystrokes: String
}

final class CameraRecorder: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let session = AVCaptureSession()
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor
    private let lock = NSLock()
    private var startedAt: UInt64 = 0
    private var pausedAt: UInt64?
    private var pausedTotal: UInt64 = 0
    private var lastTime = CMTime.invalid
    private var finished = false

    init(url: URL, deviceID: String?) throws {
        writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 1280, AVVideoHeightKey: 720,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 4_000_000, AVVideoExpectedSourceFrameRateKey: 30],
        ])
        input.expectsMediaDataInRealTime = true
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        super.init()
        guard writer.canAdd(input) else { throw CaptureError.exportFailed("The camera encoder is unavailable.") }
        writer.add(input)
        let devices = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera, .external], mediaType: .video, position: .unspecified).devices
        guard let device = devices.first(where: { $0.uniqueID == deviceID }) ?? AVCaptureDevice.default(for: .video) else {
            throw CaptureError.exportFailed("No camera is available.")
        }
        session.beginConfiguration()
        session.sessionPreset = .hd1280x720
        let cameraInput = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(cameraInput) else { throw CaptureError.exportFailed("The camera could not be opened.") }
        session.addInput(cameraInput)
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: 1280,
            kCVPixelBufferHeightKey as String: 720,
        ]
        guard session.canAddOutput(output) else { throw CaptureError.exportFailed("The camera output is unavailable.") }
        session.addOutput(output)
        output.setSampleBufferDelegate(self, queue: DispatchQueue(label: "app.screensway.capture.camera", qos: .userInitiated))
        if let connection = output.connection(with: .video) { connection.videoRotationAngle = 0 }
        session.commitConfiguration()
    }

    func start(at time: UInt64) throws {
        startedAt = time
        guard writer.startWriting() else { throw writer.error ?? CaptureError.exportFailed("The camera recording could not start.") }
        writer.startSession(atSourceTime: .zero)
        session.startRunning()
    }

    func setPaused(_ paused: Bool, at time: UInt64) { lock.withLock {
        if paused, pausedAt == nil { pausedAt = time }
        if !paused, let start = pausedAt { pausedTotal += time - start; pausedAt = nil }
    } }

    func stop(at time: UInt64) async throws {
        setPaused(false, at: time)
        session.stopRunning()
        // Frames already queued must not reach the input once it is finished (AVFoundation raises).
        lock.withLock {
            finished = true
            input.markAsFinished()
        }
        await writer.finishWriting()
        if writer.status != .completed { throw writer.error ?? CaptureError.exportFailed("The camera recording could not be finalized.") }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let buffer = sampleBuffer.imageBuffer else { return }
        lock.withLock {
            guard !finished, pausedAt == nil, input.isReadyForMoreMediaData else { return }
            let time = CMTime(value: CMTimeValue((DispatchTime.now().uptimeNanoseconds - startedAt - pausedTotal) / 1_000_000), timescale: 1_000)
            guard !lastTime.isValid || time > lastTime else { return }
            if adaptor.append(buffer, withPresentationTime: time) { lastTime = time }
        }
    }
}

/// Shortcut chords (a key pressed with ⌘, ⌃ or ⌥) seen by a listen-only event tap. Needs
/// Input Monitoring; without it the tap cannot be created and nothing is recorded. Plain
/// typing (with or without ⇧) is never stored, and macOS hides keys typed into password
/// fields from event taps altogether.
/// The microphone through macOS's voice processing, which removes the sound of the speakers
/// from the voice (echo cancellation), so recording without headphones works.
final class EchoCancelledMicrophone: @unchecked Sendable {
    private let engine = AVAudioEngine()

    init(deviceID: String?, handler: @escaping (CMSampleBuffer) -> Void) throws {
        let input = engine.inputNode
        if let deviceID, var device = Self.audioDevice(uid: deviceID), let unit = input.audioUnit {
            AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device, UInt32(MemoryLayout<AudioDeviceID>.size))
        }
        try input.setVoiceProcessingEnabled(true)
        // Keep other sound (what is being recorded) at its normal volume.
        input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw CaptureError.microphoneDenied }
        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, time in
            if time.isHostTimeValid, let sample = Self.sampleBuffer(buffer, hostTime: time.hostTime) { handler(sample) }
        }
    }

    func start() throws { try engine.start() }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    private static func audioDevice(uid: String) -> AudioDeviceID? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslateUIDToDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var uid = uid as CFString
        var device = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let status = withUnsafeMutablePointer(to: &uid) { pointer in
            AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, UInt32(MemoryLayout<CFString>.size), pointer, &size, &device)
        }
        return status == noErr && device != 0 ? device : nil
    }

    static func sampleBuffer(_ buffer: AVAudioPCMBuffer, hostTime: UInt64) -> CMSampleBuffer? {
        var description: CMAudioFormatDescription?
        guard CMAudioFormatDescriptionCreate(
            allocator: kCFAllocatorDefault, asbd: buffer.format.streamDescription, layoutSize: 0, layout: nil,
            magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &description
        ) == noErr, let description else { return nil }
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: CMTimeScale(buffer.format.sampleRate)),
            presentationTimeStamp: CMClockMakeHostTimeFromSystemUnits(hostTime),
            decodeTimeStamp: .invalid
        )
        var sample: CMSampleBuffer?
        guard CMSampleBufferCreate(
            allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil, refcon: nil,
            formatDescription: description, sampleCount: CMItemCount(buffer.frameLength), sampleTimingEntryCount: 1,
            sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sample
        ) == noErr, let sample,
            CMSampleBufferSetDataBufferFromAudioBufferList(
                sample, blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault,
                flags: 0, bufferList: buffer.audioBufferList
            ) == noErr else { return nil }
        return sample
    }
}

final class KeystrokeRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var samples: [KeystrokeSample] = []
    private var startedAt: UInt64 = 0
    private var pausedAt: UInt64?
    private var pausedNanoseconds: UInt64 = 0
    private var runLoop: CFRunLoop?
    private var thread: Thread?

    /// Whether the tap can be created; asks once (the prompt names ScreenSway).
    static func requestAccess() -> Bool {
        CGPreflightListenEventAccess() || CGRequestListenEventAccess()
    }

    func start(at time: UInt64) {
        startedAt = time
        guard Self.requestAccess() else {
            FileHandle.standardError.write(Data("SCREENSWAY_KEYSTROKES_DENIED\n".utf8))
            return
        }
        let ready = DispatchSemaphore(value: 0)
        let thread = Thread { [weak self] in
            guard let self else { ready.signal(); return }
            let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
            let callback: CGEventTapCallBack = { _, type, event, context in
                if type == .keyDown, let context {
                    Unmanaged<KeystrokeRecorder>.fromOpaque(context).takeUnretainedValue().record(event)
                }
                return Unmanaged.passUnretained(event)
            }
            guard let tap = CGEvent.tapCreate(
                tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
                eventsOfInterest: mask, callback: callback, userInfo: Unmanaged.passUnretained(self).toOpaque()
            ) else { ready.signal(); return }
            let source = CFMachPortCreateRunLoopSource(nil, tap, 0)
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            self.runLoop = CFRunLoopGetCurrent()
            ready.signal()
            CFRunLoopRun()
            CGEvent.tapEnable(tap: tap, enable: false)
        }
        thread.name = "app.screensway.capture.keys"
        self.thread = thread
        thread.start()
        ready.wait()
    }

    func setPaused(_ paused: Bool, at time: UInt64) {
        lock.withLock {
            if paused, pausedAt == nil { pausedAt = time }
            if !paused, let start = pausedAt { pausedNanoseconds += time - start; pausedAt = nil }
        }
    }

    func stop(at time: UInt64) {
        setPaused(false, at: time)
        if let runLoop { CFRunLoopStop(runLoop) }
        runLoop = nil
    }

    func snapshot() -> [KeystrokeSample] { lock.withLock { samples } }

    static func keys(flags: CGEventFlags, keyCode: Int64, characters: String) -> [String]? {
        var keys: [String] = []
        if flags.contains(.maskControl) { keys.append("⌃") }
        if flags.contains(.maskAlternate) { keys.append("⌥") }
        if flags.contains(.maskShift) { keys.append("⇧") }
        if flags.contains(.maskCommand) { keys.append("⌘") }
        // ⇧ alone is ordinary typing.
        guard flags.contains(.maskCommand) || flags.contains(.maskControl) || flags.contains(.maskAlternate) else { return nil }
        let names: [Int64: String] = [
            36: "Return", 48: "Tab", 49: "Space", 51: "Delete", 53: "Esc", 117: "⌦",
            123: "←", 124: "→", 125: "↓", 126: "↑",
            122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10", 103: "F11", 111: "F12",
        ]
        let key = names[keyCode] ?? characters.uppercased()
        guard !key.isEmpty, !key.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return keys + [key]
    }

    private func record(_ event: CGEvent) {
        // Auto-repeat of a held shortcut is one press.
        guard event.getIntegerValueField(.keyboardEventAutorepeat) == 0 else { return }
        let characters = NSEvent(cgEvent: event)?.charactersIgnoringModifiers ?? ""
        guard let keys = Self.keys(flags: event.flags, keyCode: event.getIntegerValueField(.keyboardEventKeycode), characters: characters) else { return }
        let now = DispatchTime.now().uptimeNanoseconds
        lock.withLock {
            guard pausedAt == nil else { return }
            samples.append(KeystrokeSample(timeMs: Int((now - startedAt - pausedNanoseconds) / 1_000_000), keys: keys))
        }
    }
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
    /// System audio and/or the microphone, mixed into one track. Shares the video's clock,
    /// so pauses cut both alike.
    private let audioInput: AVAssetWriterInput?
    private let audioMixer: AudioMixer?
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

    init(url: URL, width: Int, height: Int, captureAudio: Bool) throws {
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

        if captureAudio {
            let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: AudioMixer.sampleRate,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 192_000,
            ])
            audioInput.expectsMediaDataInRealTime = true
            guard writer.canAdd(audioInput) else {
                throw CaptureError.exportFailed("The audio encoder rejected the capture settings.")
            }
            writer.add(audioInput)
            self.audioInput = audioInput
            audioMixer = try AudioMixer(
                isReady: { audioInput.isReadyForMoreMediaData },
                append: { audioInput.append($0) }
            )
        } else {
            audioInput = nil
            audioMixer = nil
        }
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
            if let audioMixer, let audioInput {
                audioMixer.finish(at: end) {
                    for _ in 0..<500 where !audioInput.isReadyForMoreMediaData {
                        Thread.sleep(forTimeInterval: 0.002)
                    }
                    return audioInput.isReadyForMoreMediaData
                }
            }
            input.markAsFinished()
            audioInput?.markAsFinished()
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
        guard sampleBuffer.isValid else { return }
        if type == .audio {
            appendAudio(sampleBuffer, from: .system)
            return
        }
        if type == .microphone {
            appendAudio(sampleBuffer, from: .microphone)
            return
        }
        guard type == .screen, Self.isCompleteFrame(sampleBuffer) else { return }
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

    /// Voice from the echo-cancelled microphone, timed on the host clock like the stream's audio.
    func appendMicrophone(_ sampleBuffer: CMSampleBuffer) {
        appendAudio(sampleBuffer, from: .microphone)
    }

    private func appendAudio(_ sampleBuffer: CMSampleBuffer, from source: AudioMixer.Source) {
        lock.withLock {
            // Audio from before the recording started or while paused is not part of the video.
            guard !finished, sessionStart != nil, pausedAt == nil, let audioMixer else { return }
            audioMixer.add(sampleBuffer, from: source, at: mediaTime(sampleBuffer.presentationTimeStamp))
        }
    }

    /// Set when the encoder gave up, for example because the disk is full.
    var failure: Error? {
        writer.status == .failed ? writer.error ?? CaptureError.outputMissing : nil
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

/// Remembers why ScreenCaptureKit ended a stream on its own (a captured window closed, a
/// display was disconnected), so the recording can still be saved up to that point.
final class StreamMonitor: NSObject, SCStreamDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var stopError: Error?

    var error: Error? {
        lock.withLock { stopError }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.withLock { stopError = error }
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
    case microphoneDenied
    case cameraDenied
    case speechDenied
    case languageUnavailable(String)
    case noAudio
    case exportFailed(String)

    var errorDescription: String? {
        switch self {
        case .noDisplay: "ScreenSway could not find the main display."
        case .sourcesUnavailable: "macOS did not return the list of screens and windows. Please try again."
        case .unsupportedOS: "This capture prototype requires macOS 15 or newer."
        case .outputMissing: "Screen recording finished without creating a video file."
        case .microphoneDenied: "ScreenSway is not allowed to use the microphone."
        case .cameraDenied: "ScreenSway is not allowed to use the camera."
        case .speechDenied: "ScreenSway is not allowed to use speech recognition."
        case .languageUnavailable(let locale): "Captions in \(locale) are not available on this Mac."
        case .noAudio: "This recording has no audio to caption."
        case .exportFailed(let message): "ScreenSway could not assemble the recording: \(message)"
        }
    }
}

private let maximumEncodedDimension = 3_840.0
private let screenRecordingDeniedMarker = "SCREENSWAY_SCREEN_RECORDING_DENIED"
private let microphoneDeniedMarker = "SCREENSWAY_MICROPHONE_DENIED"
private let cameraDeniedMarker = "SCREENSWAY_CAMERA_DENIED"
private let speechDeniedMarker = "SCREENSWAY_SPEECH_DENIED"

private func isPermissionDenied(_ error: Error) -> Bool {
    let error = error as NSError
    return error.domain == SCStreamErrorDomain && error.code == SCStreamError.Code.userDeclined.rawValue
}

@main
struct ScreenSwayCapture {
    static func main() async {
        do {
            _ = await MainActor.run { NSApplication.shared }
            if let jobPath = argument(named: "--export", in: CommandLine.arguments) {
                let result = try await Exporter.run(jobURL: URL(fileURLWithPath: jobPath))
                FileHandle.standardOutput.write(try JSONEncoder.screenSway.encode(result))
                FileHandle.standardOutput.write(Data("\n".utf8))
                Foundation.exit(0)
            }
            if let videoPath = argument(named: "--transcribe", in: CommandLine.arguments),
               let outputPath = argument(named: "--output", in: CommandLine.arguments) {
                let result = try await Transcriber.run(
                    videoURL: URL(fileURLWithPath: videoPath),
                    localeIdentifier: argument(named: "--locale", in: CommandLine.arguments) ?? "en-US",
                    outputURL: URL(fileURLWithPath: outputPath)
                )
                FileHandle.standardOutput.write(try JSONEncoder.screenSway.encode(result))
                FileHandle.standardOutput.write(Data("\n".utf8))
                Foundation.exit(0)
            }
            let summary = try await run()
            let data = try JSONEncoder.screenSway.encode(summary)
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        } catch {
            // The desktop shell recognizes this marker and guides the user to System Settings.
            let message = if isPermissionDenied(error) {
                screenRecordingDeniedMarker
            } else if case CaptureError.microphoneDenied = error {
                microphoneDeniedMarker
            } else if case CaptureError.cameraDenied = error {
                cameraDeniedMarker
            } else if case CaptureError.speechDenied = error {
                speechDeniedMarker
            } else {
                "ScreenSway capture failed: \(error.localizedDescription)"
            }
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
        if arguments.contains("--list-microphones") {
            let data = try JSONEncoder.screenSway.encode(listMicrophones())
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
            Foundation.exit(0)
        }
        if let path = argument(named: "--probe", in: arguments) {
            let data = try JSONEncoder.screenSway.encode(try await probe(URL(fileURLWithPath: path), thumbnail: argument(named: "--thumbnail", in: arguments)))
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
            Foundation.exit(0)
        }
        if arguments.contains("--keystroke-access") {
            FileHandle.standardOutput.write(Data((KeystrokeRecorder.requestAccess() ? "true\n" : "false\n").utf8))
            Foundation.exit(0)
        }
        if arguments.contains("--list-cameras") {
            let data = try JSONEncoder.screenSway.encode(listCameras())
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
        let captureSystemAudio = arguments.contains("--system-audio")
        // A device ID from --list-microphones, or "default" for the system's input device.
        let microphoneID = argument(named: "--microphone", in: arguments)
        if microphoneID != nil {
            try await requireMicrophoneAccess()
        }
        let cameraID = argument(named: "--camera", in: arguments)
        if cameraID != nil { try await requireCameraAccess() }
        let controlURL = argument(named: "--control", in: arguments)
            .map { URL(fileURLWithPath: $0) }

        let projectURL = URL(fileURLWithPath: arguments[outputIndex + 1], isDirectory: true)
        let mediaURL = projectURL.appending(path: "media", directoryHint: .isDirectory)
        let metadataURL = projectURL.appending(path: "metadata", directoryHint: .isDirectory)
        let videoURL = mediaURL.appending(path: "screen.mp4")
        let cameraURL = mediaURL.appending(path: "camera.mp4")
        let pointerEventsURL = metadataURL.appending(path: "pointer-events.json")
        let keystrokesURL = metadataURL.appending(path: "keystrokes.json")

        try FileManager.default.createDirectory(at: mediaURL, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: metadataURL, withIntermediateDirectories: true)

        let content = try await shareableContent()
        let sourceKind = argument(named: "--source-kind", in: arguments) ?? "display"
        let sourceID = argument(named: "--source-id", in: arguments)

        let filter: SCContentFilter
        let captureBounds: CGRect
        let sourceRect: CGRect?

        if sourceKind == "window",
           let sourceID,
           let windowID = UInt32(sourceID),
           let window = content.windows.first(where: { $0.windowID == windowID }) {
            filter = SCContentFilter(desktopIndependentWindow: window)
            captureBounds = window.frame
            sourceRect = nil
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
            let displayBounds = CGDisplayBounds(display.displayID)
            if let value = argument(named: "--region", in: arguments),
               let region = normalizedRegion(value) {
                let local = CGRect(
                    x: region.minX * displayBounds.width,
                    y: region.minY * displayBounds.height,
                    width: region.width * displayBounds.width,
                    height: region.height * displayBounds.height
                ).integral
                sourceRect = local
                captureBounds = local.offsetBy(dx: displayBounds.minX, dy: displayBounds.minY)
            } else {
                sourceRect = nil
                captureBounds = displayBounds
            }
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
        if let sourceRect { streamConfiguration.sourceRect = sourceRect }
        streamConfiguration.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        streamConfiguration.queueDepth = 8
        streamConfiguration.showsCursor = false
        streamConfiguration.capturesAudio = captureSystemAudio
        if captureSystemAudio {
            streamConfiguration.sampleRate = AudioMixer.sampleRate
            streamConfiguration.channelCount = 2
            // ScreenSway's own UI makes no sound worth recording.
            streamConfiguration.excludesCurrentProcessAudio = true
        }
        let echoCancellation = microphoneID != nil && arguments.contains("--echo-cancellation")
        if let microphoneID, !echoCancellation {
            streamConfiguration.captureMicrophone = true
            // An unplugged device falls back to the default input instead of failing.
            if microphoneID != "default", AVCaptureDevice(uniqueID: microphoneID) != nil {
                streamConfiguration.microphoneCaptureDeviceID = microphoneID
            }
        }
        streamConfiguration.scalesToFit = true
        streamConfiguration.colorSpaceName = CGColorSpace.sRGB
        // Deliver frames in the encoder's native format so they are not converted twice.
        streamConfiguration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        streamConfiguration.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2

        let streamMonitor = StreamMonitor()
        let stream = SCStream(filter: filter, configuration: streamConfiguration, delegate: streamMonitor)

        let pointerRecorder = PointerRecorder(captureBounds: captureBounds, pixelScale: pixelScale)
        let keystrokeRecorder = CommandLine.arguments.contains("--keystrokes") ? KeystrokeRecorder() : nil
        let cameraRecorder = try cameraID.map { try CameraRecorder(url: cameraURL, deviceID: $0 == "default" ? nil : $0) }
        let videoWriter = try VideoWriter(
            url: videoURL, width: captureWidth, height: captureHeight,
            captureAudio: captureSystemAudio || microphoneID != nil
        )
        let startedAt = Date()
        try stream.addStreamOutput(
            videoWriter,
            type: .screen,
            sampleHandlerQueue: DispatchQueue(label: "app.screensway.capture.video", qos: .userInteractive)
        )
        if captureSystemAudio {
            try stream.addStreamOutput(
                videoWriter,
                type: .audio,
                sampleHandlerQueue: DispatchQueue(label: "app.screensway.capture.audio", qos: .userInteractive)
            )
        }
        // With echo cancellation the voice comes from macOS's voice processing instead.
        let voiceInput = try echoCancellation ? EchoCancelledMicrophone(deviceID: microphoneID == "default" ? nil : microphoneID) { buffer in
            videoWriter.appendMicrophone(buffer)
        } : nil
        if microphoneID != nil, !echoCancellation {
            try stream.addStreamOutput(
                videoWriter,
                type: .microphone,
                sampleHandlerQueue: DispatchQueue(label: "app.screensway.capture.microphone", qos: .userInteractive)
            )
        }

        try await stream.startCapture()
        try voiceInput?.start()
        let recordingStart = DispatchTime.now().uptimeNanoseconds
        try videoWriter.start(at: recordingStart)
        let pointerTask = pointerRecorder.start(at: recordingStart)
        keystrokeRecorder?.start(at: recordingStart)
        try cameraRecorder?.start(at: recordingStart)
        // Tells the desktop shell that frames are being recorded, so its timer starts in sync.
        FileHandle.standardError.write(Data("SCREENSWAY_READY\n".utf8))
        var isPaused = false
        let parentProcessID = getppid()
        while Date().timeIntervalSince(startedAt) < duration {
            // Save what was recorded if macOS ended the stream or the encoder failed.
            if let error = streamMonitor.error {
                FileHandle.standardError.write(Data("Capture stopped by macOS: \(error.localizedDescription)\n".utf8))
                break
            }
            if let failure = videoWriter.failure {
                throw failure
            }
            // If ScreenSway itself quits, finish the file instead of recording on unattended.
            if getppid() != parentProcessID {
                break
            }
            if let controlURL,
               let command = try? String(contentsOf: controlURL, encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines) {
                if command == "stop" {
                    break
                }
                if command == "pause", !isPaused {
                    let now = DispatchTime.now().uptimeNanoseconds
                    pointerRecorder.setPaused(true, at: now)
                    keystrokeRecorder?.setPaused(true, at: now)
                    cameraRecorder?.setPaused(true, at: now)
                    videoWriter.setPaused(true, at: now)
                    isPaused = true
                } else if command == "recording", isPaused {
                    let now = DispatchTime.now().uptimeNanoseconds
                    pointerRecorder.setPaused(false, at: now)
                    keystrokeRecorder?.setPaused(false, at: now)
                    cameraRecorder?.setPaused(false, at: now)
                    videoWriter.setPaused(false, at: now)
                    isPaused = false
                }
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        let recordingEnd = DispatchTime.now().uptimeNanoseconds
        pointerRecorder.stop(at: recordingEnd)
        voiceInput?.stop()
        keystrokeRecorder?.stop(at: recordingEnd)
        if streamMonitor.error == nil {
            try? await stream.stopCapture()
        }
        try await videoWriter.finish(at: recordingEnd)
        try await cameraRecorder?.stop(at: recordingEnd)
        await pointerTask.value

        guard FileManager.default.fileExists(atPath: videoURL.path) else {
            throw CaptureError.outputMissing
        }
        // The library shows this instead of decoding the full video for every card.
        await writeThumbnail(of: videoURL, to: mediaURL.appending(path: "thumbnail.jpg"))

        let elapsedMs = pointerRecorder.durationMilliseconds()
        let pointerEvents = pointerRecorder.snapshot()
        try JSONEncoder.screenSway.encode(pointerEvents).write(to: pointerEventsURL, options: .atomic)
        let keystrokes = keystrokeRecorder?.snapshot() ?? []
        try JSONEncoder.screenSway.encode(keystrokes).write(to: keystrokesURL, options: .atomic)

        let manifest = ProjectManifest(
            schemaVersion: 1,
            title: projectURL.deletingPathExtension().lastPathComponent,
            createdAt: ISO8601DateFormatter().string(from: startedAt),
            durationMs: elapsedMs,
            canvas: .init(width: captureWidth, height: captureHeight),
            media: .init(screen: "media/screen.mp4", camera: cameraRecorder == nil ? nil : "media/camera.mp4"),
            pointerEvents: "metadata/pointer-events.json",
            keystrokes: "metadata/keystrokes.json"
        )
        try JSONEncoder.screenSway.encode(manifest).write(
            to: projectURL.appending(path: "project.json"),
            options: .atomic
        )

        return CaptureSummary(
            projectPath: projectURL.path,
            videoPath: videoURL.path,
            pointerEventsPath: pointerEventsURL.path,
            keystrokesPath: keystrokesURL.path,
            cameraPath: cameraRecorder == nil ? nil : cameraURL.path,
            durationMs: elapsedMs,
            width: captureWidth,
            height: captureHeight,
            pointerEvents: pointerEvents,
            keystrokes: keystrokes
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

    static func listMicrophones() -> [Microphone] {
        let defaultID = AVCaptureDevice.default(for: .audio)?.uniqueID
        return AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified
        ).devices.map { device in
            Microphone(id: device.uniqueID, name: device.localizedName, isDefault: device.uniqueID == defaultID)
        }
    }

    struct Probe: Codable {
        let width: Int
        let height: Int
        let durationMs: Int
    }

    /// The picture size and length of a video to import, and optionally a library thumbnail of it.
    static func probe(_ url: URL, thumbnail: String?) async throws -> Probe {
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            throw CaptureError.exportFailed("This file has no video.")
        }
        let (size, transform) = try await track.load(.naturalSize, .preferredTransform)
        // The exporter crops the stored picture; a rotated one (a phone held upright) would come out sideways.
        guard transform.a == 1, transform.d == 1, transform.b == 0, transform.c == 0 else {
            throw CaptureError.exportFailed("Rotated videos can't be imported yet.")
        }
        let shown = size
        let duration = try await asset.load(.duration)
        if let thumbnail {
            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 640, height: 640)
            let time = CMTime(seconds: min(0.5, duration.seconds / 2), preferredTimescale: 600)
            if let image = try? await generator.image(at: time).image,
               let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: thumbnail) as CFURL, UTType.jpeg.identifier as CFString, 1, nil) {
                CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
                CGImageDestinationFinalize(destination)
            }
        }
        return Probe(width: Int(shown.width.rounded()), height: Int(shown.height.rounded()), durationMs: Int((duration.seconds * 1_000).rounded()))
    }

    static func listCameras() -> [Camera] {
        let defaultID = AVCaptureDevice.default(for: .video)?.uniqueID
        return AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .external], mediaType: .video, position: .unspecified
        ).devices.map { Camera(id: $0.uniqueID, name: $0.localizedName, isDefault: $0.uniqueID == defaultID) }
    }

    static func requireCameraAccess() async throws {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return
        case .notDetermined where await AVCaptureDevice.requestAccess(for: .video): return
        default: throw CaptureError.cameraDenied
        }
    }

    /// Asks once (the prompt names ScreenSway, which launched this helper), then remembers.
    static func requireMicrophoneAccess() async throws {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return
        case .notDetermined:
            if await AVCaptureDevice.requestAccess(for: .audio) { return }
        default:
            break
        }
        throw CaptureError.microphoneDenied
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

    static func normalizedRegion(_ value: String) -> CGRect? {
        let parts = value.split(separator: ",").compactMap { Double($0) }
        guard parts.count == 4 else { return nil }
        let rect = CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
        guard rect.minX >= 0, rect.minY >= 0, rect.width >= 0.05, rect.height >= 0.05,
              rect.maxX <= 1, rect.maxY <= 1 else { return nil }
        return rect
    }
}

extension JSONEncoder {
    static var screenSway: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}
