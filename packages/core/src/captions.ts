/** One recognized word, in milliseconds on the recording's timeline. */
export interface CaptionWord {
  text: string;
  startMs: number;
  endMs: number;
}

/** One caption on screen. The text can be edited; the timing comes from the words. */
export interface CaptionLine {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface CaptionOptions {
  /** Longest line, in characters, before it wraps to a new caption. */
  maxChars: number;
  /** Longest time one caption stays up. */
  maxMs: number;
  /** A silence this long always starts a new caption. */
  pauseMs: number;
}

export const DEFAULT_CAPTION_OPTIONS: CaptionOptions = { maxChars: 42, maxMs: 5_000, pauseMs: 700 };
/** Captions stay up a little after the last word, unless the next one starts first. */
const LINGER_MS = 400;

/**
 * Groups words into readable captions. Speech is first cut into phrases at pauses and
 * sentence ends; a phrase too long for one caption is split into balanced lines,
 * preferring to break after a comma, so lines read naturally instead of filling up and
 * spilling one word over.
 */
export function buildCaptionLines(words: CaptionWord[], options: CaptionOptions = DEFAULT_CAPTION_OPTIONS): CaptionLine[] {
  const phrases: CaptionWord[][] = [];
  let current: CaptionWord[] = [];
  for (const word of words) {
    const previous = current.at(-1);
    if (previous && (word.startMs - previous.endMs >= options.pauseMs || /[.!?…]$/.test(previous.text))) {
      phrases.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length > 0) phrases.push(current);

  const groups = phrases.flatMap((phrase) => splitBalanced(phrase, options));
  const lines = groups.map((group, index) => ({
    id: `caption-${index + 1}`,
    startMs: group[0].startMs,
    endMs: group.at(-1)!.endMs,
    text: joinWords(group.map((word) => word.text)),
  }));

  // Linger after the last word, but never into the next caption.
  return lines.map((line, index) => ({
    ...line,
    endMs: Math.min(line.endMs + LINGER_MS, lines[index + 1]?.startMs ?? Infinity),
  }));
}

/** Splits a phrase into as few lines as fit, each about equally long. */
function splitBalanced(phrase: CaptionWord[], options: CaptionOptions): CaptionWord[][] {
  const text = joinWords(phrase.map((word) => word.text));
  const durationMs = phrase.at(-1)!.endMs - phrase[0].startMs;
  const count = Math.min(phrase.length, Math.max(Math.ceil(text.length / options.maxChars), Math.ceil(durationMs / options.maxMs)));
  if (count <= 1) return [phrase];

  // Character offset where each word ends, to aim every break at an equal share.
  const ends: number[] = [];
  let length = 0;
  for (const word of phrase) {
    length += (length > 0 ? 1 : 0) + word.text.length;
    ends.push(length);
  }
  const groups: CaptionWord[][] = [];
  let start = 0;
  for (let line = 1; line < count; line++) {
    const target = (length * line) / count;
    let best = -1;
    let bestScore = Infinity;
    for (let index = start; index < phrase.length - (count - line); index++) {
      // A comma within reach is worth a slightly uneven split.
      const score = Math.abs(ends[index] - target) - (/[,;:]$/.test(phrase[index].text) ? options.maxChars * 0.25 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = index;
      }
    }
    groups.push(phrase.slice(start, best + 1));
    start = best + 1;
  }
  groups.push(phrase.slice(start));
  // A balanced split can still leave a line too long (very long words); split it again.
  return groups.flatMap((group) =>
    group.length > 1 && joinWords(group.map((word) => word.text)).length > options.maxChars ? splitBalanced(group, options) : [group],
  );
}

/** Joins words with spaces, keeping punctuation attached to the word before it. */
function joinWords(words: string[]): string {
  return words.reduce((text, word) => (text === "" ? word : /^[.,!?;:…)]/.test(word) ? text + word : `${text} ${word}`), "");
}

/** The caption shown at `timeMs`, if any. */
export function captionAt(lines: CaptionLine[], timeMs: number): CaptionLine | null {
  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].endMs <= timeMs) low = mid + 1;
    else if (lines[mid].startMs > timeMs) high = mid - 1;
    else return lines[mid];
  }
  return null;
}

/**
 * Captions inside the kept part of a recording, shifted so the kept part starts at 0
 * and clipped to it. Empty captions are dropped.
 */
export function trimCaptions(lines: CaptionLine[], startMs: number, endMs: number): CaptionLine[] {
  return lines
    .filter((line) => line.text.trim() !== "" && line.endMs > startMs && line.startMs < endMs)
    .map((line) => ({
      ...line,
      startMs: Math.max(line.startMs, startMs) - startMs,
      endMs: Math.min(line.endMs, endMs) - startMs,
    }));
}

/** SubRip subtitles, accepted by YouTube, Premiere, Final Cut and most players. */
export function toSrt(lines: CaptionLine[]): string {
  const time = (milliseconds: number) => {
    const total = Math.max(0, Math.round(milliseconds));
    const hours = Math.floor(total / 3_600_000);
    const minutes = Math.floor((total % 3_600_000) / 60_000);
    const seconds = Math.floor((total % 60_000) / 1_000);
    const pad = (value: number, width = 2) => String(value).padStart(width, "0");
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(total % 1_000, 3)}`;
  };
  return lines
    .map((line, index) => `${index + 1}\n${time(line.startMs)} --> ${time(line.endMs)}\n${line.text.trim()}\n`)
    .join("\n");
}
