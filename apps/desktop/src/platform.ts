/** The desktop shell runs on macOS and Windows; a few controls and words differ. */
export const isWindows = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");

/** Both native helpers support system loopback and a selected microphone. */
export const supportsAudio = true;
