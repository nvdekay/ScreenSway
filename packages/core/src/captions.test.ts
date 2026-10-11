import { describe, expect, it } from "vitest";
import { buildCaptionLines, captionAt, toSrt, trimCaptions, type CaptionWord } from "./captions";

const words = (text: string, startMs: number, gapMs = 0, wordMs = 300): CaptionWord[] =>
  text.split(" ").map((word, index) => ({
    text: word,
    startMs: startMs + index * (wordMs + gapMs),
    endMs: startMs + index * (wordMs + gapMs) + wordMs,
  }));

describe("buildCaptionLines", () => {
  it("starts a new caption after a pause", () => {
    const lines = buildCaptionLines([...words("Xin chào các bạn.", 0), ...words("Hôm nay mình làm video", 3_000)]);
    expect(lines.map((line) => line.text)).toEqual(["Xin chào các bạn.", "Hôm nay mình làm video"]);
    expect(lines[0].startMs).toBe(0);
    expect(lines[0].endMs).toBe(1_200 + 400);
  });

  it("wraps long speech into lines that fit and keeps every word once", () => {
    const sentence = "đầu tiên bạn chọn màn hình cần quay sau đó bấm nút bắt đầu rồi thao tác như bình thường trên máy";
    const lines = buildCaptionLines(words(sentence, 1_000));
    for (const line of lines) expect(line.text.length).toBeLessThanOrEqual(42);
    expect(lines.map((line) => line.text).join(" ")).toBe(sentence);
    for (let index = 1; index < lines.length; index++) {
      expect(lines[index].startMs).toBeGreaterThanOrEqual(lines[index - 1].endMs);
    }
  });

  it("never keeps a caption up longer than five seconds", () => {
    const slow = buildCaptionLines(words("một hai ba bốn năm sáu", 0, 600, 500));
    for (const line of slow) expect(line.endMs - line.startMs).toBeLessThanOrEqual(5_000 + 400);
    expect(slow.length).toBeGreaterThan(1);
  });

  it("breaks after every finished sentence", () => {
    const lines = buildCaptionLines(words("Xin chào. Bạn chọn màn hình cần quay trước. Sau đó bấm nút", 0));
    expect(lines.map((line) => line.text)).toEqual(["Xin chào.", "Bạn chọn màn hình cần quay trước.", "Sau đó bấm nút"]);
  });

  it("splits a long sentence into balanced lines instead of spilling one word over", () => {
    const lines = buildCaptionLines(words("Hôm nay mình sẽ hướng dẫn cách quay màn hình bằng ScreenSway.", 0));
    expect(lines.map((line) => line.text)).toEqual(["Hôm nay mình sẽ hướng dẫn cách", "quay màn hình bằng ScreenSway."]);
  });

  it("prefers to break after a comma", () => {
    const lines = buildCaptionLines(words("Đầu tiên, bạn chọn màn hình cần quay, sau đó bấm nút bắt đầu.", 0));
    expect(lines.map((line) => line.text)).toEqual(["Đầu tiên, bạn chọn màn hình cần quay,", "sau đó bấm nút bắt đầu."]);
  });

  it("attaches separate punctuation to the previous word", () => {
    const lines = buildCaptionLines([
      { text: "Hello", startMs: 0, endMs: 300 },
      { text: ",", startMs: 300, endMs: 310 },
      { text: "world", startMs: 320, endMs: 600 },
      { text: "!", startMs: 600, endMs: 610 },
    ]);
    expect(lines[0].text).toBe("Hello, world!");
  });

  it("handles no words", () => {
    expect(buildCaptionLines([])).toEqual([]);
  });
});

describe("captions on the timeline", () => {
  const lines = buildCaptionLines([...words("one two", 0), ...words("three four", 2_000), ...words("five six", 5_000)]);

  it("finds the caption on screen", () => {
    expect(captionAt(lines, 100)?.text).toBe("one two");
    expect(captionAt(lines, 1_500)).toBeNull();
    expect(captionAt(lines, 2_400)?.text).toBe("three four");
    expect(captionAt(lines, 99_000)).toBeNull();
  });

  it("shifts and clips captions to the kept part and drops empty ones", () => {
    const edited = lines.map((line) => (line.text === "five six" ? { ...line, text: "  " } : line));
    const trimmed = trimCaptions(edited, 300, 4_000);
    expect(trimmed.map((line) => [line.text, line.startMs, line.endMs])).toEqual([
      ["one two", 0, 700],
      ["three four", 1_700, 2_700],
    ]);
  });

  it("writes SubRip with hours, milliseconds and blank lines between captions", () => {
    const srt = toSrt([
      { id: "a", startMs: 0, endMs: 1_234, text: "Xin chào" },
      { id: "b", startMs: 3_723_005, endMs: 3_725_000, text: " Tạm biệt " },
    ]);
    expect(srt).toBe("1\n00:00:00,000 --> 00:00:01,234\nXin chào\n\n2\n01:02:03,005 --> 01:02:05,000\nTạm biệt\n");
  });
});
