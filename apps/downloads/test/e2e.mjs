// End-to-end check of the downloads Worker against a throwaway local R2 bucket, driven by
// scripts/publish-downloads.mjs with a stand-in `gh` that serves fake release assets.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publisher = join(root, "..", "..", "scripts", "publish-downloads.mjs");
const work = mkdtempSync(join(tmpdir(), "screensway-downloads-"));
const port = 8798;
const base = `http://127.0.0.1:${port}`;
const wrangler = join(root, "node_modules", ".bin", "wrangler");
const MiB = 1024 * 1024;
const DMG = "ScreenSway-macos-universal.dmg", MAC_UPDATE = "ScreenSway-macos-universal.app.tar.gz", EXE = "ScreenSway-windows-x64-setup.exe";
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

// Fake releases: <work>/releases/<tag>/<asset>, served by a `gh` stand-in on PATH.
const bin = join(work, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const { readdirSync, copyFileSync } = require("node:fs");
const { join } = require("node:path");
const [, , , verb, tag, ...rest] = process.argv;
const release = join(process.env.FAKE_RELEASES, tag);
if (verb === "view") console.log(readdirSync(release).join("\\n"));
if (verb === "download") copyFileSync(join(release, rest[rest.indexOf("--pattern") + 1]), join(rest[rest.indexOf("--dir") + 1], rest[rest.indexOf("--pattern") + 1]));
`);
chmodSync(join(bin, "gh"), 0o755);

function release(tag, files) {
  const directory = join(work, "releases", tag);
  mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
  return directory;
}

function publish(tag, directory) {
  const result = spawnSync(process.execPath, [publisher, tag, directory], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_RELEASES: join(work, "releases"), DOWNLOADS_URL: base, DOWNLOADS_UPLOAD_TOKEN: "secret", DOWNLOADS_PART_SIZE: String(5 * MiB) },
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

const server = spawn(wrangler, ["dev", "--port", String(port), "--persist-to", join(work, "state"), "--var", "UPLOAD_TOKEN:secret"], { cwd: root, stdio: "pipe" });
let log = "";
server.stdout.on("data", (chunk) => (log += chunk));
server.stderr.on("data", (chunk) => (log += chunk));

try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(`${base}/current`)).ok) break;
    } catch {}
    if (attempt > 120) throw new Error(`wrangler dev did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.deepEqual(await (await fetch(`${base}/current`)).json(), { tag: null });
  assert.equal((await fetch(`${base}/latest/${DMG}`)).status, 404);

  // A release is copied in 5 MiB parts; the installer comes from the release, the rest locally.
  const dmg = randomBytes(12 * MiB + 123), update = randomBytes(1_000), exe = randomBytes(6 * MiB);
  release("v0.3.1", { [DMG]: dmg, [MAC_UPDATE]: update, [EXE]: exe, [`${EXE}.sha256`]: `${sha(exe)}  ${EXE}\n` });
  const local = join(work, "download-0.3.1");
  mkdirSync(local);
  writeFileSync(join(local, DMG), dmg);
  writeFileSync(join(local, `${EXE}.sha256`), `${sha(exe)}  ${EXE}\n`);
  let run = publish("v0.3.1", local);
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(await (await fetch(`${base}/current`)).json(), { tag: "v0.3.1" });

  let response = await fetch(`${base}/latest/${DMG}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Disposition"), `attachment; filename="${DMG}"`);
  assert.equal(response.headers.get("X-Checksum-Sha256"), sha(dmg));
  assert.match(response.headers.get("Cache-Control"), /max-age=300/);
  assert.equal(sha(Buffer.from(await response.arrayBuffer())), sha(dmg));
  response = await fetch(`${base}/v0.3.1/${EXE}`);
  assert.match(response.headers.get("Cache-Control"), /immutable/);
  assert.equal(sha(Buffer.from(await response.arrayBuffer())), sha(exe));
  // Interrupted downloads can resume.
  response = await fetch(`${base}/latest/${DMG}`, { headers: { Range: "bytes=100-199" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("Content-Range"), `bytes 100-199/${dmg.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), dmg.subarray(100, 200));
  response = await fetch(`${base}/latest/${EXE}`, { method: "HEAD" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Length"), String(exe.length));

  // Only the known files are served, and only the workflow can write.
  assert.equal((await fetch(`${base}/latest/secret.txt`)).status, 404);
  assert.equal((await fetch(`${base}/v0.3.1/%2e%2e`)).status, 404);
  assert.equal((await fetch(`${base}/admin/current`, { method: "PUT", body: JSON.stringify({ tag: "v0.3.1" }) })).status, 401);
  assert.equal((await fetch(`${base}/admin/uploads/v0.3.1/${DMG}`, { method: "POST", headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await fetch(`${base}/admin/current`, { method: "PUT", headers: { Authorization: "Bearer secret" }, body: JSON.stringify({ tag: "v9.9.9" }) })).status, 409);

  // Publishing the same release again uploads nothing.
  run = publish("v0.3.1", local);
  assert.equal(run.status, 0, run.output);
  assert.equal(run.output.match(/already uploaded/g)?.length, 3, run.output);

  // A release without its Windows installer is left alone.
  const partial = release("v0.3.2", { [DMG]: dmg, [MAC_UPDATE]: update });
  run = publish("v0.3.2", partial);
  assert.equal(run.status, 2, run.output);
  assert.deepEqual(await (await fetch(`${base}/current`)).json(), { tag: "v0.3.1" });

  // Each switch keeps the previous release for clients mid-update and removes older ones.
  writeFileSync(join(partial, EXE), exe);
  assert.equal(publish("v0.3.2", mkdtempSync(join(work, "dl-"))).status, 0);
  release("v0.3.3", { [DMG]: dmg, [MAC_UPDATE]: update, [EXE]: exe });
  run = publish("v0.3.3", mkdtempSync(join(work, "dl-")));
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /previous: v0\.3\.2; removed 3 old files/);
  assert.equal((await fetch(`${base}/v0.3.1/${DMG}`)).status, 404);
  assert.equal((await fetch(`${base}/v0.3.2/${DMG}`)).status, 200);

  // The updater feed: only the workflow can replace it, and it must look like a feed.
  const feedUrl = `${base}/update/latest.json`;
  assert.equal((await fetch(feedUrl)).status, 404);
  const feed = { version: "0.3.3", platforms: { "darwin-aarch64": { url: `${base}/v0.3.3/${MAC_UPDATE}`, signature: "sig" } } };
  assert.equal((await fetch(`${base}/admin/update`, { method: "PUT", body: JSON.stringify(feed) })).status, 401);
  assert.equal((await fetch(`${base}/admin/update`, { method: "PUT", headers: { Authorization: "Bearer secret" }, body: "{}" })).status, 400);
  response = await fetch(`${base}/admin/update`, { method: "PUT", headers: { Authorization: "Bearer secret" }, body: JSON.stringify(feed) });
  assert.equal(response.status, 200);
  response = await fetch(feedUrl);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.deepEqual(await response.json(), feed);
  console.log("downloads e2e: ok");
} finally {
  server.kill("SIGTERM");
  rmSync(work, { recursive: true, force: true });
}
