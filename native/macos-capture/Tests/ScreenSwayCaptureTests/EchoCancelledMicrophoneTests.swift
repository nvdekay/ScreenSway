import AVFoundation
import CoreMedia
import Testing
@testable import ScreenSwayCapture

struct EchoCancelledMicrophoneTests {
    @Test func wrapsVoiceBuffersWithTheirHostTime() throws {
        let format = try #require(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 480))
        buffer.frameLength = 480
        for index in 0..<480 { buffer.floatChannelData![0][index] = sin(Float(index) / 10) * 0.5 }
        let hostTime = mach_absolute_time()
        let sample = try #require(EchoCancelledMicrophone.sampleBuffer(buffer, hostTime: hostTime))
        #expect(CMSampleBufferGetNumSamples(sample) == 480)
        #expect(sample.presentationTimeStamp == CMClockMakeHostTimeFromSystemUnits(hostTime))
        #expect(sample.dataBuffer?.dataLength == 480 * MemoryLayout<Float>.size)
    }
}
