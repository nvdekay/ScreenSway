// The landing page's version for the statistics: the app version plus the commit it was
// built from, e.g. `0.4.0+c235699`. Plain JavaScript so vite.config.ts needs no Node types.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** What the analytics API accepts as a label. */
const LABEL = /^[\w .:+<>×-]{1,40}$/;

export function buildVersion() {
  const { version } = JSON.parse(readFileSync(new URL("../desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  let commit = process.env.GITHUB_SHA?.slice(0, 7);
  if (!commit) {
    try {
      commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      // Not a git checkout, or no git: the app version alone.
    }
  }
  const full = commit && /^[0-9a-f]{4,40}$/.test(commit) ? `${version}+${commit}` : version;
  return LABEL.test(full) ? full : LABEL.test(version) ? version : "unknown";
}
