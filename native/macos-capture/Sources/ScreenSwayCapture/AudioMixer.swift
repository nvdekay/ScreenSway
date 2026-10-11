import AVFoundation
import CoreMedia
import Foundation

/// Mixes system audio and the microphone into the recording's single stereo audio track.
///
/// Both sources arrive on their own queues with host-clock timestamps. Each buffer is
/// placed on a shared sample timeline (the video's clock, pauses already removed) and
/// summed; a region is encoded once it is older than `latency`, so a source that lags a
/// little behind the other is still mixed in. One track keeps the file playable
/// everywhere (most players only play the first audio track) and lets export copy it as is.
///
/// Not thread-safe: the owner calls it with its own lock held.
final class AudioMixer {
    enum Source: Hashable {
        case system
        case microphone
    }

    static let sampleRate = 48_000
    private static let channels = 2
    /// How far behind the newest audio the mix is finalized.
    private static let latency = sampleRate / 2
    /// Timestamps within this distance of where a source left off continue it seamlessly.
    private static let continuityTolerance = sampleRate / 50

    private let isReady: () -> Bool
    private let append: (CMSampleBuffer) -> Void
    private let formatDescription: CMAudioFormatDescription
    private var converters: [Source: SourceConverter] = [:]
    private var voice = VoiceProcessor(sampleRate: Double(sampleRate))
    /// The pending mix, interleaved stereo, starting at sample `pendingStart`.
    private var pending: [Float] = []
    private var pendingStart: Int64 = 0
    private var newestSample: Int64 = 0
    private var expectedNext: [Source: Int64] = [:]

    /// `append` receives the mixed audio in order; nothing is written while `isReady` is false.
    init(isReady: @escaping () -> Bool, append: @escaping (CMSampleBuffer) -> Void) throws {
        self.isReady = isReady
        self.append = append
        var description = AudioStreamBasicDescription(
            mSampleRate: Float64(Self.sampleRate),
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: UInt32(MemoryLayout<Float>.size * Self.channels),
            mFramesPerPacket: 1,
            mBytesPerFrame: UInt32(MemoryLayout<Float>.size * Self.channels),
            mChannelsPerFrame: UInt32(Self.channels),
            mBitsPerChannel: 32,
            mReserved: 0
        )
        var formatDescription: CMAudioFormatDescription?
        guard CMAudioFormatDescriptionCreate(
            allocator: kCFAllocatorDefault, asbd: &description, layoutSize: 0, layout: nil,
            magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &formatDescription
        ) == noErr, let formatDescription else {
            throw CaptureError.exportFailed("The audio mixer could not be set up.")
        }
        self.formatDescription = formatDescription
    }

    /// Adds a captured buffer that starts at `mediaTime` on the recording's timeline.
    func add(_ sampleBuffer: CMSampleBuffer, from source: Source, at mediaTime: CMTime) {
        let converter = converters[source] ?? SourceConverter()
        converters[source] = converter
        guard var channels = converter.convert(sampleBuffer), let frameCount = channels.first?.count,
              frameCount > 0 else { return }

        if source == .microphone {
            // Speech is mono; process one channel and place it in the middle of the mix.
            var mono = channels[0]
            if channels.count > 1 {
                for channel in channels.dropFirst() {
                    for index in mono.indices { mono[index] += channel[index] }
                }
                let scale = 1 / Float(channels.count)
                for index in mono.indices { mono[index] *= scale }
            }
            voice.process(&mono)
                channels = [mono, mono]
        } else if channels.count == 1 {
            channels.append(channels[0])
        }

        var start = Int64((mediaTime.seconds * Double(Self.sampleRate)).rounded())
        if let expected = expectedNext[source], abs(start - expected) <= Int64(Self.continuityTolerance) {
            start = expected
        }
        expectedNext[source] = start + Int64(frameCount)
        mix(left: channels[0], right: channels[1], at: start)
        newestSample = max(newestSample, start + Int64(frameCount))
        flush(upTo: newestSample - Int64(Self.latency))
    }

    /// Writes everything up to `end`, filling silence where no source had audio.
    func finish(at end: CMTime, waitUntilReady: () -> Bool) {
        let endSample = Int64((end.seconds * Double(Self.sampleRate)).rounded())
        while pendingStart < endSample {
            guard waitUntilReady() else { return }
            flush(upTo: min(endSample, pendingStart + Int64(Self.sampleRate)))
        }
    }

    private func mix(left: [Float], right: [Float], at start: Int64) {
        // Audio that arrives after its region was written is dropped.
        let skip = Int(max(0, pendingStart - start))
        guard skip < left.count else { return }
        let offset = Int(start + Int64(skip) - pendingStart)
        let needed = (offset + left.count - skip) * Self.channels
        if pending.count < needed {
            pending.append(contentsOf: repeatElement(0, count: needed - pending.count))
        }
        for frame in skip..<left.count {
            let index = (offset + frame - skip) * Self.channels
            pending[index] += left[frame]
            pending[index + 1] += right[frame]
        }
    }

    private func flush(upTo end: Int64) {
        let frameCount = Int(end - pendingStart)
        guard frameCount > 0, isReady() else { return }
        let sampleCount = frameCount * Self.channels
        if pending.count < sampleCount {
            pending.append(contentsOf: repeatElement(0, count: sampleCount - pending.count))
        }
        for index in 0..<sampleCount {
            pending[index] = Self.softClip(pending[index])
        }
        let time = CMTime(value: pendingStart, timescale: CMTimeScale(Self.sampleRate))
        if let buffer = makeSampleBuffer(frameCount: frameCount, at: time) {
            append(buffer)
        }
        pending.removeFirst(sampleCount)
        pendingStart = end
    }

    private func makeSampleBuffer(frameCount: Int, at time: CMTime) -> CMSampleBuffer? {
        let length = frameCount * Self.channels * MemoryLayout<Float>.size
        var blockBuffer: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: length,
            blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
            dataLength: length, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &blockBuffer
        ) == noErr, let blockBuffer else { return nil }
        let copied = pending.withUnsafeBytes { bytes in
            CMBlockBufferReplaceDataBytes(
                with: bytes.baseAddress!, blockBuffer: blockBuffer, offsetIntoDestination: 0, dataLength: length
            )
        }
        guard copied == noErr else { return nil }
        var sampleBuffer: CMSampleBuffer?
        guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            allocator: kCFAllocatorDefault, dataBuffer: blockBuffer, formatDescription: formatDescription,
            sampleCount: frameCount, presentationTimeStamp: time, packetDescriptions: nil,
            sampleBufferOut: &sampleBuffer
        ) == noErr else { return nil }
        return sampleBuffer
    }

    /// Leaves normal levels untouched and rounds off peaks instead of clipping them hard.
    /// The ceiling sits just under full scale: AAC encoding overshoots peaks a little, and
    /// loud system audio plus a voice would otherwise clip in the file.
    static func softClip(_ sample: Float) -> Float {
        let knee: Float = 0.8
        let ceiling: Float = 0.94
        let magnitude = abs(sample)
        guard magnitude > knee else { return sample }
        let limited = knee + (ceiling - knee) * tanh((magnitude - knee) / (ceiling - knee))
        return sample < 0 ? -limited : limited
    }
}

/// Turns captured buffers of any PCM layout into 48 kHz float channels.
private final class SourceConverter {
    private var converter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?

    func convert(_ sampleBuffer: CMSampleBuffer) -> [[Float]]? {
        guard let description = sampleBuffer.formatDescription?.audioStreamBasicDescription else { return nil }
        var streamDescription = description
        guard let format = AVAudioFormat(streamDescription: &streamDescription) else { return nil }
        let frameCount = AVAudioFrameCount(sampleBuffer.numSamples)
        guard frameCount > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return nil }
        buffer.frameLength = frameCount
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer, at: 0, frameCount: Int32(frameCount), into: buffer.mutableAudioBufferList
        ) == noErr else { return nil }

        if format.commonFormat == .pcmFormatFloat32, !format.isInterleaved,
           format.sampleRate == Double(AudioMixer.sampleRate) {
            return Self.channels(of: buffer)
        }

        let channelCount = min(format.channelCount, 2)
        guard let outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: Double(AudioMixer.sampleRate),
            channels: channelCount, interleaved: false
        ) else { return nil }
        if inputFormat != format || converter == nil {
            converter = AVAudioConverter(from: format, to: outputFormat)
            inputFormat = format
        }
        guard let converter else { return nil }
        let capacity = AVAudioFrameCount(
            (Double(frameCount) * outputFormat.sampleRate / format.sampleRate).rounded(.up)
        ) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return nil }
        // The converter asks for input until told there is none; hand it this buffer once.
        let pendingInput = PendingInput(buffer)
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            guard let input = pendingInput.take() else {
                status.pointee = .noDataNow
                return nil
            }
            status.pointee = .haveData
            return input
        }
        guard error == nil else { return nil }
        return Self.channels(of: output)
    }

    private static func channels(of buffer: AVAudioPCMBuffer) -> [[Float]]? {
        guard let data = buffer.floatChannelData else { return nil }
        let count = Int(buffer.frameLength)
        return (0..<min(Int(buffer.format.channelCount), 2)).map { channel in
            Array(UnsafeBufferPointer(start: data[channel], count: count))
        }
    }
}

/// Converter callbacks are synchronous; this only satisfies the Sendable checker.
private final class PendingInput: @unchecked Sendable {
    private var buffer: AVAudioPCMBuffer?

    init(_ buffer: AVAudioPCMBuffer) {
        self.buffer = buffer
    }

    func take() -> AVAudioPCMBuffer? {
        defer { buffer = nil }
        return buffer
    }
}

/// Makes a built-in or headset microphone sound clear without user settings:
/// removes rumble, brings speech to a steady level, lowers background noise between
/// phrases and rounds off peaks.
struct VoiceProcessor {
    private let blockSize: Int
    private var highPass: Biquad
    private var noiseFloorDb: Float = -60
    /// Smoothed levels of the last 300 blocks (3 s).
    private var recentLevelsDb: [Float] = []
    private var floorUpdateCountdown = 0
    private var startupBlocks = 0
    private var detectorDb: Float = -100
    private var smoothedEnergy: Float = -1
    /// Typical level of a voice on a laptop microphone, refined as soon as someone speaks.
    private var speechDb: Float = -30
    private var gainDb: Float = 0
    private var gateDb: Float = 0
    private var holdBlocks = 0
    private var appliedGain: Float
    /// Leftover samples that did not fill a whole analysis block yet.
    private var carry: [Float] = []
    private var carryOut: [Float] = []

    static let targetDb: Float = -20
    static let maximumBoostDb: Float = 12
    static let gateRangeDb: Float = -12
    static let peakCeilingDb: Float = -3

    init(sampleRate: Double) {
        blockSize = Int(sampleRate / 100)
        highPass = Biquad.highPass(frequency: 90, sampleRate: sampleRate)
        appliedGain = Self.linear(gainDb)
    }

    /// Processes `samples` in place. Output lags input by less than one 10 ms block.
    mutating func process(_ samples: inout [Float]) {
        for index in samples.indices {
            samples[index] = highPass.process(samples[index])
        }
        carry.append(contentsOf: samples)
        var processed: [Float] = carryOut
        processed.reserveCapacity(carryOut.count + carry.count)
        var start = 0
        while carry.count - start >= blockSize {
            processed.append(contentsOf: processBlock(carry[start..<(start + blockSize)]))
            start += blockSize
        }
        carry.removeFirst(start)
        // Keep the output the same length as the input; the remainder waits for the next call.
        let count = samples.count
        if processed.count >= count {
            samples = Array(processed.prefix(count))
            carryOut = Array(processed.dropFirst(count))
        } else {
            samples = Array(repeating: 0, count: count - processed.count) + processed
            carryOut = []
        }
    }

    private mutating func processBlock(_ block: ArraySlice<Float>) -> [Float] {
        var energy: Float = 0
        var peak: Float = 0
        for sample in block {
            energy += sample * sample
            peak = max(peak, abs(sample))
        }
        let levelDb = 10 * log10(energy / Float(block.count) + 1e-12)
        let peakDb = 20 * log10(peak + 1e-9)
        // Averaged over about 30 ms, so the flutter of background noise does not look like speech.
        let blockEnergy = energy / Float(block.count)
        smoothedEnergy = smoothedEnergy < 0 ? blockEnergy : smoothedEnergy + (blockEnergy - smoothedEnergy) * 0.3
        let smoothedDb = 10 * log10(smoothedEnergy + 1e-12)
        updateNoiseFloor(smoothedDb)
        // The detector envelope bridges the short gaps between syllables.
        detectorDb = max(smoothedDb, detectorDb - 1)
        let speechThreshold = max(noiseFloorDb + 12, -55)
        let isSpeech = detectorDb > speechThreshold
        // Until the room has been heard for a moment, pass the voice through unchanged.
        let isListening = recentLevelsDb.count >= 50

        // Learn the speaking level only from clearly voiced blocks.
        if isListening, levelDb > speechThreshold {
            let rate: Float = levelDb > speechDb ? 0.05 : 0.01
            speechDb += (levelDb - speechDb) * rate
        }
        holdBlocks = isSpeech || !isListening ? 25 : max(0, holdBlocks - 1)

        // Level the voice slowly (5 dB/s up, 50 dB/s down) so it never pumps.
        let wantedGain = isListening
            ? min(Self.maximumBoostDb, max(-Self.maximumBoostDb, Self.targetDb - speechDb))
            : gainDb
        let step: Float = wantedGain > gainDb ? 0.05 : 0.5
        gainDb += max(-step, min(step, wantedGain - gainDb))

        // Open quickly when someone speaks, close gently after a short hold.
        let wantedGate: Float = holdBlocks > 0 ? 0 : Self.gateRangeDb
        gateDb += wantedGate > gateDb ? min(3, wantedGate - gateDb) : max(-0.3, wantedGate - gateDb)

        // A sudden loud sound is turned down within this block instead of clipping.
        let ceilingDb = Self.peakCeilingDb - peakDb
        if gainDb + gateDb > ceilingDb {
            gainDb = min(gainDb, ceilingDb - gateDb)
        }
        let targetGain = Self.linear(min(gainDb + gateDb, ceilingDb))
        let startGain = min(appliedGain, targetGain)
        let increment = (targetGain - startGain) / Float(block.count)
        var output = [Float](repeating: 0, count: block.count)
        for (offset, sample) in block.enumerated() {
            output[offset] = AudioMixer.softClip(sample * (startGain + increment * Float(offset + 1)))
        }
        appliedGain = targetGain
        return output
    }

    /// Background noise is the quiet end of the last three seconds: speech always has short
    /// pauses. A low percentile rather than the minimum ignores brief dips such as a
    /// microphone fading in. Near-silence says nothing about the room and is skipped; the
    /// speech threshold never goes below -55 dB anyway.
    private mutating func updateNoiseFloor(_ levelDb: Float) {
        // The first 0.3 s often holds the microphone starting up.
        startupBlocks += 1
        guard startupBlocks > 30, levelDb > -67 else { return }
        recentLevelsDb.append(levelDb)
        if recentLevelsDb.count > 300 { recentLevelsDb.removeFirst() }
        floorUpdateCountdown -= 1
        guard floorUpdateCountdown <= 0 || recentLevelsDb.count == 50 else { return }
        floorUpdateCountdown = 10
        guard recentLevelsDb.count >= 50 else { return }
        let sorted = recentLevelsDb.sorted()
        noiseFloorDb = sorted[sorted.count / 10]
    }

    private static func linear(_ decibels: Float) -> Float {
        pow(10, decibels / 20)
    }
}

/// A second-order IIR filter (RBJ cookbook coefficients).
struct Biquad {
    private let b0, b1, b2, a1, a2: Float
    private var x1: Float = 0, x2: Float = 0, y1: Float = 0, y2: Float = 0

    static func highPass(frequency: Double, sampleRate: Double, q: Double = 0.7071) -> Biquad {
        let omega = 2 * Double.pi * frequency / sampleRate
        let alpha = sin(omega) / (2 * q)
        let cosine = cos(omega)
        let a0 = 1 + alpha
        return Biquad(
            b0: Float((1 + cosine) / 2 / a0),
            b1: Float(-(1 + cosine) / a0),
            b2: Float((1 + cosine) / 2 / a0),
            a1: Float(-2 * cosine / a0),
            a2: Float((1 - alpha) / a0)
        )
    }

    private init(b0: Float, b1: Float, b2: Float, a1: Float, a2: Float) {
        (self.b0, self.b1, self.b2, self.a1, self.a2) = (b0, b1, b2, a1, a2)
    }

    mutating func process(_ x: Float) -> Float {
        let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        (x2, x1, y2, y1) = (x1, x, y1, y)
        return y
    }
}
