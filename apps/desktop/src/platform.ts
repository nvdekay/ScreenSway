/** The desktop shell runs on macOS and Windows; a few controls and words differ. */
export const isWindows = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");

/** Both native helpers support system loopback and a selected microphone. */
export const supportsAudio = true;

declare const __SCREENSWAY_WEB__: boolean | undefined;
/**
 * The browser version (apps/studio-web) reuses the studio: the pointer is part of the video
 * there, captions are not available and exports are downloaded instead of saved to disk.
 */
export const isWeb = typeof __SCREENSWAY_WEB__ !== "undefined" && __SCREENSWAY_WEB__ === true;
