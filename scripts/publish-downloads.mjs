// Copies a release's installers and updater bundles to the downloads Worker (apps/downloads)
// and makes it the release the landing page offers.
//
//   node scripts/publish-downloads.mjs <tag> <directory>
//
// <directory> holds the release's `.sha256` files and any assets already downloaded.
// Files whose checksum already matches the Worker are skipped; missing ones are fetched
// with `gh release download`. Exits with 2, uploading nothing, when the release does not
// have every installer yet (macOS is published before the Windows build finishes).
// Env: DOWNLOADS_URL, DOWNLOADS_UPLOAD_TOKEN, optional DOWNLOADS_PART_SIZE (bytes).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, openSync, readSync, closeSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const FILES = [
  "ScreenSway-macos-universal.dmg",
  "ScreenSway-macos-universal.app.tar.gz",
  "ScreenSway-windows-x64-setup.exe",
];
const [tag, directory] = process.argv.slice(2);
const base = process.env.DOWNLOADS_URL?.replace(/\/$/, "");
const token = process.env.DOWNLOADS_UPLOAD_TOKEN;
// Workers accept request bodies up to 100 MB; R2 needs equal parts of at least 5 MiB.
const partSize = Number(process.env.DOWNLOADS_PART_SIZE ?? 64 * 1024 * 1024);
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "") || !directory || !base || !token) {
  console.error("Usage: DOWNLOADS_URL=… DOWNLOADS_UPLOAD_TOKEN=… node scripts/publish-downloads.mjs <tag> <directory>");
  process.exit(1);
}

const auth = { Authorization: `Bearer ${token}` };

async function request(method, url, init = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { method, ...init, headers: { ...auth, ...init.headers } });
      if (response.ok || (response.status < 500 && response.status !== 429)) return response;
      if (attempt >= 4) return response;
    } catch (error) {
      if (attempt >= 4) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
  }
}

async function expect(response, what) {
  if (!response.ok) throw new Error(`${what} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
  });
}

function recordedChecksum(file) {
  const checksum = path.join(directory, `${file}.sha256`);
  return existsSync(checksum) ? readFileSync(checksum, "utf8").trim().split(/\s+/)[0].toLowerCase() : null;
}

function releaseAssets() {
  const output = execFileSync("gh", ["release", "view", tag, "--json", "assets", "--jq", ".assets[].name"], { encoding: "utf8" });
  return new Set(output.split("\n").filter(Boolean));
}

async function upload(file, local, checksum) {
  const url = `${base}/admin/uploads/${tag}/${file}`;
  const { uploadId } = await expect(await request("POST", url, { headers: { "X-Checksum-Sha256": checksum } }), `Starting ${file}`);
  const size = statSync(local).size;
  const descriptor = openSync(local, "r");
  const parts = [];
  try {
    for (let offset = 0, partNumber = 1; offset < size || partNumber === 1; offset += partSize, partNumber++) {
      const buffer = Buffer.alloc(Math.min(partSize, size - offset));
      readSync(descriptor, buffer, 0, buffer.length, offset);
      const query = `?uploadId=${encodeURIComponent(uploadId)}&part=${partNumber}`;
      parts.push(await expect(await request("PUT", url + query, { body: buffer }), `Uploading ${file} part ${partNumber}`));
      process.stdout.write(`  ${file}: ${Math.min(size, offset + buffer.length)} / ${size} bytes\n`);
      if (size === 0) break;
    }
  } finally {
    closeSync(descriptor);
  }
  const completed = await expect(
    await request("POST", `${url}/complete?uploadId=${encodeURIComponent(uploadId)}`, {
      body: JSON.stringify({ parts }),
      headers: { "Content-Type": "application/json" },
    }),
    `Completing ${file}`,
  );
  if (completed.size !== size) throw new Error(`${file} was stored with ${completed.size} bytes instead of ${size}`);
}

const assets = releaseAssets();
const missing = FILES.filter((file) => !assets.has(file));
if (missing.length) {
  console.log(`${tag} does not have ${missing.join(", ")} yet; keeping the current downloads.`);
  process.exit(2);
}

for (const file of FILES) {
  const remote = await request("HEAD", `${base}/${tag}/${file}`);
  const stored = remote.ok ? remote.headers.get("X-Checksum-Sha256") : null;
  const recorded = recordedChecksum(file);
  if (stored && recorded && stored === recorded) {
    console.log(`${file}: already uploaded (${stored})`);
    continue;
  }
  const local = path.join(directory, file);
  if (!existsSync(local)) execFileSync("gh", ["release", "download", tag, "--pattern", file, "--dir", directory, "--clobber"], { stdio: "inherit" });
  const checksum = await sha256(local);
  if (recorded && recorded !== checksum) throw new Error(`${file} does not match its published checksum`);
  if (stored === checksum) {
    console.log(`${file}: already uploaded (${stored})`);
    continue;
  }
  console.log(`${file}: uploading (${checksum})`);
  await upload(file, local, checksum);
}

const result = await expect(
  await request("PUT", `${base}/admin/current`, { body: JSON.stringify({ tag }), headers: { "Content-Type": "application/json" } }),
  "Switching the current release",
);
console.log(`Now offering ${result.tag} (previous: ${result.previous ?? "none"}; removed ${result.removed.length} old files).`);
