import CoreGraphics
import Testing
@testable import ScreenSwayCapture

struct KeystrokeTests {
    @Test func recordsShortcutChordsInMacOrder() {
        #expect(KeystrokeRecorder.keys(flags: [.maskCommand, .maskShift], keyCode: 1, characters: "s") == ["⇧", "⌘", "S"])
        #expect(KeystrokeRecorder.keys(flags: [.maskControl], keyCode: 123, characters: "") == ["⌃", "←"])
    }

    @Test func ignoresOrdinaryTyping() {
        #expect(KeystrokeRecorder.keys(flags: [], keyCode: 0, characters: "a") == nil)
        #expect(KeystrokeRecorder.keys(flags: [.maskShift], keyCode: 0, characters: "A") == nil)
    }
}
