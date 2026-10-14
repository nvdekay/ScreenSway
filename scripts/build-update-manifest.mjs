import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] ?? path.join(root, "apps/web/dist/update/latest.json"));
const directory = path.dirname(output);
// The release being offered, which can lag behind the version on main while a release
// is still building. Announcing main's version with older files would loop updates.
const version = process.env.UPDATE_VERSION?.replace(/^v/, "")
  ?? JSON.parse(readFileSync(path.join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8")).version;
// Versioned files on the downloads Worker, e.g. https://…workers.dev/v0.3.2
const base = process.env.UPDATE_BASE_URL?.replace(/\/$/, "");
if (!base) throw new Error("UPDATE_BASE_URL is required");
const mac = "ScreenSway-macos-universal.app.tar.gz";
const windows = "ScreenSway-windows-x64-setup.exe";
const signature = (name) => readFileSync(path.join(directory, `${name}.sig`), "utf8").trim();

const manifest = {
  version,
  notes: process.env.UPDATE_NOTES ?? `ScreenSway ${version}`,
  pub_date: process.env.UPDATE_PUB_DATE ?? new Date().toISOString(),
  platforms: {
    "darwin-aarch64": { url: `${base}/${mac}`, signature: signature(mac) },
    "darwin-x86_64": { url: `${base}/${mac}`, signature: signature(mac) },
    "windows-x86_64": { url: `${base}/${windows}`, signature: signature(windows) },
  },
};

writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote signed updater manifest for ScreenSway ${version}: ${output}`);
