/** The desktop shell runs on macOS and Windows; a few controls and words differ. */
export const isWindows = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");

/** The Windows helper does not record audio yet. */
export const supportsAudio = !isWindows;
