import AVFoundation
import CoreMedia
import Foundation
import Testing
@testable import ScreenSwayCapture

private let sampleRate = 48_000

/// Deterministic noise, so failures are reproducible.
private struct Noise {
    private var state: UInt64 = 0x9E37_79B9_7F4A_7C15

    mutating func next() -> Float {
        state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        return Float(Int64(bitPattern: state >> 11) % 2_000_001) / 1_000_000 - 1
    }
}

private func decibels(_ samples: ArraySlice<Float>) -> Float {
    let energy = samples.reduce(Float(0)) { $0 + $1 * $1 } / Float(max(1, samples.count))
    return 10 * log10(energy + 1e-12)
}

private func seconds(_ from: Double, _ to: Double) -> Range<Int> {
    Int(from * Double(sampleRate))..<Int(to * Double(sampleRate))
}

/// A voice-like signal (harmonics of a gliding pitch with a syllable envelope) at `rms` dBFS.
private func voice(count: Int, rms: Float) -> [Float] {
    var phase: Double = 0
    var samples = [Float](repeating: 0, count: count)
    for index in 0..<count {
        let time = Double(index) / Double(sampleRate)
        phase += 2 * .pi * (140 + 30 * sin(2 * .pi * 0.7 * time)) / Double(sampleRate)
        let syllables = Float(0.55 + 0.45 * sin(2 * .pi * 4 * time))
        var value: Float = 0
        for harmonic in 1...8 {
            value += Float(sin(phase * Double(harmonic))) / Float(harmonic)
        }
        samples[index] = value * syllables
    }
    let scale = pow(10, (rms - decibels(samples[...])) / 20)
    return samples.map { $0 * scale }
}

/// Feeds the processor in capture-sized chunks, the way ScreenCaptureKit delivers audio.
private func process(_ input: [Float]) -> [Float] {
    var processor = VoiceProcessor(sampleRate: Double(sampleRate))
    var output: [Float] = []
    var start = 0
    while start < input.count {
        var chunk = Array(input[start..<min(start + 512, input.count)])
        processor.process(&chunk)
        output += chunk
        start += 512
    }
    return output
}

@Suite struct VoiceProcessorTests {
    @Test func bringsQuietSpeechToASteadyLevelAndLowersNoiseBetweenPhrases() {
        var noise = Noise()
        var input = (0..<(sampleRate * 12)).map { _ in noise.next() * 0.006 } // about -49 dBFS
        let phrase = voice(count: sampleRate * 2, rms: -34)
        for phraseStart in [1.0, 4.0, 7.0, 10.0] {
            let range = seconds(phraseStart, phraseStart + 2)
            for (offset, index) in range.enumerated() { input[index] += phrase[offset] }
        }

        let output = process(input)
        #expect(output.count == input.count)
        // Once the level is learned, speech sits close to the target.
        let laterSpeech = decibels(output[seconds(7.5, 8.9)])
        #expect(abs(laterSpeech - VoiceProcessor.targetDb) <= 4, "speech at \(laterSpeech) dBFS")
        let lastSpeech = decibels(output[seconds(10.5, 11.9)])
        #expect(abs(lastSpeech - VoiceProcessor.targetDb) <= 4, "speech at \(lastSpeech) dBFS")
        // Pauses between phrases are much quieter than speech, and quieter than the raw noise.
        let pause = decibels(output[seconds(9.5, 9.95)])
        #expect(laterSpeech - pause >= 24, "pause at \(pause) dBFS")
        #expect(pause <= decibels(input[seconds(9.5, 9.95)]) + 2)
    }

    @Test func doesNotBoostRoomNoiseBeforeAnyoneSpeaks() {
        var noise = Noise()
        let input = (0..<(sampleRate * 4)).map { _ in noise.next() * 0.02 } // about -38 dBFS
        let output = process(input)
        #expect(decibels(output[seconds(1, 4)]) <= decibels(input[seconds(1, 4)]) + 1)
    }

    @Test func turnsDownSuddenLoudSoundsWithoutClipping() {
        var input = voice(count: sampleRate * 3, rms: -32)
        input += voice(count: sampleRate, rms: -4)
        let output = process(input)
        #expect(output.allSatisfy { abs($0) <= 1 })
        let loud = decibels(output[seconds(3, 4)])
        #expect(loud <= -8, "loud passage at \(loud) dBFS")
        // Even its first instant stays below full scale.
        let onset = output[seconds(3, 3.02)].map(abs).max() ?? 0
        #expect(onset < 0.95)
    }

    @Test func removesLowFrequencyRumble() {
        let hum = (0..<(sampleRate * 2)).map { Float(sin(2 * .pi * 30 * Double($0) / Double(sampleRate))) * 0.1 }
        var filter = Biquad.highPass(frequency: 90, sampleRate: Double(sampleRate))
        let filtered = hum.map { filter.process($0) }
        #expect(decibels(hum[seconds(1, 2)]) - decibels(filtered[seconds(1, 2)]) >= 15)
        let tone = (0..<(sampleRate * 2)).map { Float(sin(2 * .pi * 1_000 * Double($0) / Double(sampleRate))) * 0.1 }
        var speechFilter = Biquad.highPass(frequency: 90, sampleRate: Double(sampleRate))
        let passed = tone.map { speechFilter.process($0) }
        #expect(abs(decibels(tone[seconds(1, 2)]) - decibels(passed[seconds(1, 2)])) < 0.2)
    }
}

/// Collects the mixer's output as one interleaved stereo stream.
private final class MixedOutput {
    var samples: [Float] = []
    var buffers: [(start: CMTime, frames: Int)] = []
    var ready = true

    func receive(_ buffer: CMSampleBuffer) {
        buffers.append((buffer.presentationTimeStamp, buffer.numSamples))
        var blockLength = 0
        var pointer: UnsafeMutablePointer<CChar>?
        let block = buffer.dataBuffer!
        CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &blockLength, dataPointerOut: &pointer)
        pointer!.withMemoryRebound(to: Float.self, capacity: blockLength / 4) { floats in
            samples += UnsafeBufferPointer(start: floats, count: blockLength / 4)
        }
    }

    func left(_ range: Range<Int>) -> ArraySlice<Float> {
        ArraySlice(range.map { samples[$0 * 2] })
    }
}

/// A capture buffer like ScreenCaptureKit's: float PCM, `channels` channels.
private func captureBuffer(_ channels: [[Float]], interleaved: Bool, rate: Int = sampleRate) -> CMSampleBuffer {
    let format = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: Double(rate),
        channels: AVAudioChannelCount(channels.count), interleaved: interleaved
    )!
    let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(channels[0].count))!
    pcm.frameLength = AVAudioFrameCount(channels[0].count)
    if interleaved {
        let data = pcm.floatChannelData![0]
        for frame in channels[0].indices {
            for channel in channels.indices { data[frame * channels.count + channel] = channels[channel][frame] }
        }
    } else {
        for channel in channels.indices {
            for frame in channels[channel].indices { pcm.floatChannelData![channel][frame] = channels[channel][frame] }
        }
    }
    var description: CMAudioFormatDescription?
    CMAudioFormatDescriptionCreate(
        allocator: nil, asbd: format.streamDescription, layoutSize: 0, layout: nil,
        magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &description
    )
    var buffer: CMSampleBuffer?
    var timing = CMSampleTimingInfo(
        duration: CMTime(value: 1, timescale: CMTimeScale(rate)), presentationTimeStamp: .zero, decodeTimeStamp: .invalid
    )
    CMSampleBufferCreate(
        allocator: nil, dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil, refcon: nil,
        formatDescription: description, sampleCount: channels[0].count, sampleTimingEntryCount: 1,
        sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &buffer
    )
    CMSampleBufferSetDataBufferFromAudioBufferList(
        buffer!, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0,
        bufferList: pcm.audioBufferList
    )
    return buffer!
}

private func time(_ seconds: Double) -> CMTime {
    CMTime(seconds: seconds, preferredTimescale: 48_000)
}

@Suite struct AudioMixerTests {
    @Test func placesSystemAudioOnTheTimelineAndFillsGapsWithSilence() throws {
        let output = MixedOutput()
        let mixer = try AudioMixer(isReady: { output.ready }, append: output.receive)
        let tone = (0..<4_800).map { Float(sin(Double($0) * 0.05)) * 0.5 }
        // Ten contiguous 0.1 s buffers starting at 1 s, with timestamps jittered by 0.2 ms.
        for index in 0..<10 {
            let jitter = index == 0 ? 0 : index % 2 == 0 ? 0.0002 : -0.0002
            mixer.add(captureBuffer([tone, tone], interleaved: false), from: .system, at: time(1 + Double(index) * 0.1 + jitter))
        }
        mixer.finish(at: time(2.5)) { true }

        #expect(output.samples.count == Int(2.5 * Double(sampleRate)) * 2)
        #expect(decibels(output.left(seconds(0, 0.99))) < -100)
        #expect(decibels(output.left(seconds(2.01, 2.5))) < -100)
        // Jittered buffers are joined seamlessly: the tone repeats exactly every buffer.
        let joined = Array(output.left(seconds(1, 2)))
        for index in 0..<10 {
            #expect(Array(joined[(index * 4_800)..<(index * 4_800 + 100)]) == Array(tone[0..<100]))
        }
        // Buffers come out in order and back to back.
        var expected = CMTime.zero
        for (index, buffer) in output.buffers.enumerated() {
            #expect(buffer.start == expected, "buffer \(index) starts at \(buffer.start.seconds)")
            expected = buffer.start + CMTime(value: CMTimeValue(buffer.frames), timescale: CMTimeScale(sampleRate))
        }
    }

    @Test func mixesTheMicrophoneIntoBothChannels() throws {
        let output = MixedOutput()
        let mixer = try AudioMixer(isReady: { true }, append: output.receive)
        let silence = [Float](repeating: 0, count: 4_800)
        let speech = voice(count: sampleRate * 2, rms: -30)
        for index in 0..<20 {
            mixer.add(captureBuffer([silence, silence], interleaved: false), from: .system, at: time(Double(index) * 0.1))
            let chunk = Array(speech[(index * 4_800)..<((index + 1) * 4_800)])
            // ScreenCaptureKit delivers the microphone as interleaved mono.
            mixer.add(captureBuffer([chunk], interleaved: true), from: .microphone, at: time(Double(index) * 0.1))
        }
        mixer.finish(at: time(2)) { true }

        #expect(output.samples.count == sampleRate * 2 * 2)
        let left = output.left(seconds(1, 2))
        let right = ArraySlice(seconds(1, 2).map { output.samples[$0 * 2 + 1] })
        #expect(decibels(left) > -40)
        #expect(left == right)
    }

    @Test func convertsOtherSampleRates() throws {
        let output = MixedOutput()
        let mixer = try AudioMixer(isReady: { true }, append: output.receive)
        let tone = (0..<44_100).map { Float(sin(2 * .pi * 440 * Double($0) / 44_100)) * 0.3 }
        for index in 0..<10 {
            let chunk = Array(tone[(index * 4_410)..<((index + 1) * 4_410)])
            mixer.add(captureBuffer([chunk, chunk], interleaved: false, rate: 44_100), from: .system, at: time(Double(index) * 0.1))
        }
        mixer.finish(at: time(1)) { true }
        #expect(output.samples.count == sampleRate * 2)
        #expect(abs(decibels(output.left(seconds(0.2, 0.9))) - decibels(tone[...])) < 1)
    }

    @Test func waitsForTheEncoderInsteadOfDroppingAudio() throws {
        let output = MixedOutput()
        output.ready = false
        let mixer = try AudioMixer(isReady: { output.ready }, append: output.receive)
        let tone = [Float](repeating: 0.25, count: 4_800)
        for index in 0..<20 {
            mixer.add(captureBuffer([tone, tone], interleaved: false), from: .system, at: time(Double(index) * 0.1))
        }
        #expect(output.samples.isEmpty)
        output.ready = true
        mixer.finish(at: time(2)) { true }
        #expect(output.samples.count == sampleRate * 2 * 2)
        #expect(output.samples.allSatisfy { $0 == 0.25 })
    }

    @Test func dropsAudioThatArrivesAfterItsRegionWasWritten() throws {
        let output = MixedOutput()
        let mixer = try AudioMixer(isReady: { true }, append: output.receive)
        let quiet = [Float](repeating: 0, count: 4_800)
        for index in 0..<20 {
            mixer.add(captureBuffer([quiet, quiet], interleaved: false), from: .system, at: time(Double(index) * 0.1))
        }
        let late = [Float](repeating: 0.5, count: 4_800)
        mixer.add(captureBuffer([late, late], interleaved: false), from: .microphone, at: time(0.2))
        mixer.finish(at: time(2)) { true }
        #expect(output.samples.count == sampleRate * 2 * 2)
        #expect(decibels(output.left(seconds(0, 1.4))) < -100)
    }

    @Test func softClipLeavesNormalLevelsAlone() {
        #expect(AudioMixer.softClip(0.5) == 0.5)
        #expect(AudioMixer.softClip(-0.75) == -0.75)
        #expect(AudioMixer.softClip(3) <= 0.95)
        #expect(AudioMixer.softClip(-3) >= -0.95)
        #expect(AudioMixer.softClip(0.95) > AudioMixer.softClip(0.92))
    }
}
