/** An area of a display to record, in percent of the display's width and height. */
export interface CaptureArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Thousandths of a percent, rounded down, so an area never ends past the display's edge.
const floor = (value: number) => Math.floor(value * 1_000) / 1_000;

/** The height in percent for a width in percent that gives the area `ratio` (width ÷ height). */
const heightFor = (width: number, ratio: number, displayAspect: number) => (width * displayAspect) / ratio;

/** The largest area of `ratio` centred on a display of `displayAspect`. */
export function centredArea(ratio: number, displayAspect: number): CaptureArea {
  // As tall as the display when narrower than it, otherwise as wide.
  const width = floor(ratio <= displayAspect ? (100 * ratio) / displayAspect : 100);
  const height = floor(heightFor(width, ratio, displayAspect));
  return { x: floor((100 - width) / 2), y: floor((100 - height) / 2), width, height };
}

/**
 * `current` with one field typed in. With a fixed `ratio`, changing one side changes the
 * other and moving never resizes; either way the area stays on the display, at least 5 %.
 */
export function changeArea(current: CaptureArea, key: keyof CaptureArea, value: number, ratio: number | null, displayAspect: number): CaptureArea {
  if (ratio !== null && (key === "width" || key === "height")) {
    const wanted = key === "width" ? value : (value * ratio) / displayAspect;
    const smallest = Math.max(5, (5 * ratio) / displayAspect);
    const width = floor(Math.max(smallest, Math.min(wanted, 100 - current.x, ((100 - current.y) * ratio) / displayAspect)));
    return { ...current, width, height: floor(heightFor(width, ratio, displayAspect)) };
  }
  if (ratio !== null) {
    const size = key === "x" ? current.width : current.height;
    return { ...current, [key]: floor(Math.max(0, Math.min(value, 100 - size))) };
  }
  const next = { ...current, [key]: Math.round(value) };
  next.width = Math.max(5, Math.min(next.width, 100 - next.x));
  next.height = Math.max(5, Math.min(next.height, 100 - next.y));
  next.x = Math.max(0, Math.min(next.x, 100 - next.width));
  next.y = Math.max(0, Math.min(next.y, 100 - next.height));
  return next;
}
