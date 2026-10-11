export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** Like formatDuration, with tenths of a second, for trimming: 0:04.3 */
export function formatPrecise(milliseconds: number): string {
  const tenths = Math.max(0, Math.round(milliseconds / 100));
  return `${formatDuration(Math.floor(tenths / 10) * 1_000)}.${tenths % 10}`;
}
