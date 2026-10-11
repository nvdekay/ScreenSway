import Foundation
import Testing
@testable import ScreenSwayCapture

@Suite struct TranscriberTests {
    private let rate = Int(Transcriber.sampleRate)

    /// Speech-like noise with a 300 ms pause every `pauseEvery` seconds.
    private func speech(seconds: Double, pauseEvery: Double) -> [Float] {
        var state: UInt32 = 12_345
        return (0..<Int(seconds * Double(rate))).map { index in
            state = state &* 1_664_525 &+ 1_013_904_223
            let time = Double(index) / Double(rate)
            let inPause = time.truncatingRemainder(dividingBy: pauseEvery) > pauseEvery - 0.3
            return inPause ? 0 : (Float(state >> 9) / Float(1 << 23) - 0.5) * 0.2
        }
    }

    @Test func shortAudioIsOneChunk() {
        let ranges = Transcriber.chunkRanges(for: [Float](repeating: 0.1, count: rate * 12))
        #expect(ranges == [0..<(rate * 12)])
    }

    @Test func longAudioIsCutInQuietMomentsWithoutGapsOrOverlaps() {
        let samples = speech(seconds: 150, pauseEvery: 7)
        let ranges = Transcriber.chunkRanges(for: samples)
        #expect(ranges.first?.lowerBound == 0)
        #expect(ranges.last?.upperBound == samples.count)
        for (previous, next) in zip(ranges, ranges.dropFirst()) {
            #expect(previous.upperBound == next.lowerBound)
        }
        for range in ranges.dropLast() {
            let seconds = Double(range.count) / Double(rate)
            #expect(seconds >= Transcriber.minimumChunkSeconds && seconds <= Transcriber.maximumChunkSeconds)
            // Every cut lands inside a pause, never in the middle of a word.
            let cut = Double(range.upperBound) / Double(rate)
            #expect(cut.truncatingRemainder(dividingBy: 7) > 6.7 - 0.03, "cut at \(cut) s")
        }
    }

    @Test func silenceIsMeasuredAsSilence() {
        #expect(Transcriber.level(of: [Float](repeating: 0, count: 1_000)) < Transcriber.silenceDb)
        #expect(Transcriber.level(of: speech(seconds: 1, pauseEvery: 10)) > Transcriber.silenceDb)
        #expect(Transcriber.level(of: [Float]()) < Transcriber.silenceDb)
    }
}

@Suite struct HeardWordsTests {
    private func word(_ text: String, _ start: Int) -> CaptionWord {
        CaptionWord(text: text, startMs: start, endMs: start + 200)
    }

    @Test func keepsWordsWhenTheFinalResultIsEmpty() {
        let heard = HeardWords()
        heard.merge([word("Xin", 0), word("chào", 300)])
        heard.merge([])
        #expect(heard.words.map(\.text) == ["Xin", "chào"])
    }

    @Test func laterResultsReplaceWhatTheyCoverAndKeepEarlierWords() {
        let heard = HeardWords()
        heard.merge([word("hello", 0), word("word", 400)])
        heard.merge([word("world", 400), word("again", 800)])
        heard.merge([word("next", 2_000)])
        #expect(heard.words.map(\.text) == ["hello", "world", "again", "next"])
    }
}
