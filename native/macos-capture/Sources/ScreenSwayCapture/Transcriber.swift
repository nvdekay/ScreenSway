import AVFoundation
import Foundation
import Speech

/// One recognized word, in milliseconds on the recording's timeline.
struct CaptionWord: Codable, Equatable {
    let text: String
    let startMs: Int
    let endMs: Int
}

struct TranscriptionResult: Codable {
    let locale: String
    let words: [CaptionWord]
}

/// Turns a recording's audio into timed words with Apple's on-device speech recognition.
/// Nothing leaves the Mac: requests require on-device recognition.
///
/// The audio is cut into chunks of 20–40 s at its quietest moments and each chunk is
/// recognized on its own. That bounds memory, gives real progress, avoids any length
/// limit of a single request and skips silent stretches entirely.
enum Transcriber {
    static let sampleRate = 16_000.0
    static let minimumChunkSeconds = 20.0
    static let maximumChunkSeconds = 40.0
    /// Chunks quieter than this hold no speech worth sending to the recognizer.
    static let silenceDb: Float = -50

    static func run(videoURL: URL, localeIdentifier: String, outputURL: URL) async throws -> TranscriptionResult {
        try await requireAuthorization()
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)) else {
            throw CaptureError.languageUnavailable(localeIdentifier)
        }
        guard recognizer.supportsOnDeviceRecognition else {
            throw CaptureError.languageUnavailable(localeIdentifier)
        }

        let samples = try await readAudio(from: videoURL)
        let chunks = chunkRanges(for: samples)
        var words: [CaptionWord] = []
        reportProgress(0)
        for (index, range) in chunks.enumerated() {
            let chunk = Array(samples[range])
            if level(of: chunk) > silenceDb {
                let offsetMs = Int(Double(range.lowerBound) / sampleRate * 1_000)
                words += try await recognize(chunk, with: recognizer).map {
                    CaptionWord(text: $0.text, startMs: $0.startMs + offsetMs, endMs: $0.endMs + offsetMs)
                }
            }
            reportProgress((index + 1) * 100 / chunks.count)
        }

        let result = TranscriptionResult(locale: localeIdentifier, words: words)
        try JSONEncoder.screenSway.encode(result).write(to: outputURL, options: .atomic)
        return result
    }

    private static func requireAuthorization() async throws {
        let status: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard status == .authorized else { throw CaptureError.speechDenied }
    }

    /// The first audio track as 16 kHz mono floats, the format speech recognition works in.
    static func readAudio(from url: URL) async throws -> [Float] {
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else {
            throw CaptureError.noAudio
        }
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false,
            AVLinearPCMIsBigEndianKey: false,
        ])
        reader.add(output)
        guard reader.startReading() else {
            throw reader.error ?? CaptureError.exportFailed("The recording's audio could not be read.")
        }
        var samples: [Float] = []
        while let buffer = output.copyNextSampleBuffer() {
            guard let block = buffer.dataBuffer else { continue }
            let length = CMBlockBufferGetDataLength(block)
            var chunk = [Float](repeating: 0, count: length / MemoryLayout<Float>.size)
            chunk.withUnsafeMutableBytes { bytes in
                _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: bytes.baseAddress!)
            }
            samples += chunk
        }
        if reader.status == .failed { throw reader.error ?? CaptureError.noAudio }
        return samples
    }

    /// Splits the audio at the quietest 50 ms between 20 and 40 s into each chunk.
    static func chunkRanges(for samples: [Float]) -> [Range<Int>] {
        let window = Int(sampleRate * 0.05)
        let minimum = Int(sampleRate * minimumChunkSeconds)
        let maximum = Int(sampleRate * maximumChunkSeconds)
        var ranges: [Range<Int>] = []
        var start = 0
        while start < samples.count {
            if samples.count - start <= maximum {
                ranges.append(start..<samples.count)
                break
            }
            var cut = start + maximum
            var quietest = Float.greatestFiniteMagnitude
            var position = start + minimum
            while position + window <= start + maximum {
                let energy = level(of: samples[position..<(position + window)])
                if energy < quietest {
                    quietest = energy
                    cut = position + window / 2
                }
                position += window
            }
            ranges.append(start..<cut)
            start = cut
        }
        return ranges
    }

    static func level<C: Collection>(of samples: C) -> Float where C.Element == Float {
        guard !samples.isEmpty else { return -120 }
        let energy = samples.reduce(Float(0)) { $0 + $1 * $1 } / Float(samples.count)
        return 10 * log10(energy + 1e-12)
    }

    private static func recognize(_ samples: [Float], with recognizer: SFSpeechRecognizer) async throws -> [CaptionWord] {
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)) else { return [] }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { source in
            buffer.floatChannelData![0].update(from: source.baseAddress!, count: samples.count)
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        request.addsPunctuation = true
        request.taskHint = .dictation
        request.append(buffer)
        request.endAudio()

        // The recognizer can deliver the words in an intermediate result and finish with an
        // empty final one, or split the audio into several results. Each result replaces
        // what was heard from its first word on, so the merged list is the full transcript.
        let gate = ResumeGate()
        let heard = HeardWords()
        return try await withCheckedThrowingContinuation { continuation in
            recognizer.recognitionTask(with: request) { result, error in
                if let result {
                    heard.merge(words(from: result.bestTranscription))
                }
                if result?.isFinal == true {
                    gate.once { continuation.resume(returning: heard.words) }
                } else if let error {
                    gate.once {
                        // "No speech detected" is an answer, not a failure.
                        if (error as NSError).code == 1110 || !heard.words.isEmpty {
                            continuation.resume(returning: heard.words)
                        } else {
                            continuation.resume(throwing: error)
                        }
                    }
                }
            }
        }
    }

    static func words(from transcription: SFTranscription) -> [CaptionWord] {
        transcription.segments.compactMap { segment in
            let text = segment.substring.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            let start = Int((segment.timestamp * 1_000).rounded())
            return CaptionWord(text: text, startMs: start, endMs: start + max(1, Int((segment.duration * 1_000).rounded())))
        }
    }

    private static func reportProgress(_ percent: Int) {
        FileHandle.standardError.write(Data("SCREENSWAY_PROGRESS \(percent)\n".utf8))
    }
}

/// Words collected across the results of one recognition task. Recognition callbacks
/// arrive one at a time on the recognizer's queue.
final class HeardWords: @unchecked Sendable {
    private(set) var words: [CaptionWord] = []

    func merge(_ newWords: [CaptionWord]) {
        guard let first = newWords.first else { return }
        words = words.filter { $0.startMs < first.startMs } + newWords
    }
}
