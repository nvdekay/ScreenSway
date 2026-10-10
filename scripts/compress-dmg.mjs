// Recompresses Tauri's macOS DMG with LZMA (ULMO), which is about 25% smaller than
// the default zlib (UDZO) image. ULMO images open on macOS 10.15 and later.
import { execFileSync } from "node:child_process";
import { readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  throw new Error("DMG compression requires macOS.");
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] ?? "universal-apple-darwin";
const dmgDirectory = path.join(repositoryRoot, "apps/desktop/src-tauri/target", target, "release/bundle/dmg");
const images = readdirSync(dmgDirectory).filter((name) => name.endsWith(".dmg"));
if (images.length === 0) throw new Error(`No DMG found in ${dmgDirectory}`);

for (const name of images) {
  const image = path.join(dmgDirectory, name);
  const compressed = `${image}.ulmo.dmg`;
  const before = statSync(image).size;
  rmSync(compressed, { force: true });
  execFileSync("hdiutil", ["convert", image, "-format", "ULMO", "-o", compressed], { stdio: "ignore" });
  execFileSync("hdiutil", ["verify", compressed], { stdio: "ignore" });
  renameSync(compressed, image);
  const after = statSync(image).size;
  console.log(`${name}: ${(before / 1e6).toFixed(2)} MB -> ${(after / 1e6).toFixed(2)} MB`);
}
