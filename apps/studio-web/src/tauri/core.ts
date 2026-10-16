// Stand-in for @tauri-apps/api/core: the studio's commands are answered in the browser.
import { commands } from "../backend";

export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const handler = commands[command];
  if (!handler) throw new Error(`${command} is not available in the browser.`);
  return (await handler(args)) as T;
}

/** Recordings are already blob: URLs in the browser. */
export function convertFileSrc(path: string): string {
  return path;
}
