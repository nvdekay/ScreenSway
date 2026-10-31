// Releases ScreenSway from the owner's computers instead of GitHub Actions: the same
// steps as release.yml, windows.yml and web.yml, run by hand.
//
//   node scripts/release-local.mjs macos     on the Mac: test, build and sign the universal app
//   node scripts/release-local.mjs windows   on the Windows PC: test and build the installer
//   node scripts/release-local.mjs publish   on the Mac: sign the Windows installer, publish the
//                                            GitHub release, the downloads, the feed and the site
//   node scripts/release-local.mjs site      on the Mac: rebuild and deploy the site only
//
// Files are collected in release/vX.Y.Z/ (not committed); copy the Windows installer from
// the PC into the same folder on the Mac before `publish`. The updater key never leaves the
// Mac: the Windows build makes no updater files and `publish` signs the installer. The key
// password is asked for in the terminal unless TAURI_SIGNING_PRIVATE_KEY_PASSWORD is set.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(path.join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8")).version;
const tag = `v${version}`;
const folder = path.join(root, "release", tag);
const DOWNLOADS_URL = "https://download.screensway.site";
const ANALYTICS_URL = "https://stats.screensway.site";
const MAC_DMG = "ScreenSway-macos-universal.dmg";
const MAC_UPDATER = "ScreenSway-macos-universal.app.tar.gz";
const WINDOWS = "ScreenSway-windows-x64-setup.exe";
const windows = process.platform === "win32";

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: windows, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal})`);
}

function output(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", shell: windows }).trim();
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Writes `<file>.sha256` in the format `shasum -a 256` uses, as the workflows did. */
function recordChecksum(file) {
  const checksum = sha256(file);
  writeFileSync(`${file}.sha256`, `${checksum}  ${path.basename(file)}\n`);
  return checksum;
}

function ask(question, hidden) {
  if (!process.stdin.isTTY) throw new Error("Run this in a terminal, or set TAURI_SIGNING_PRIVATE_KEY_PASSWORD.");
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) prompt._writeToOutput = (text) => text.includes(question) && process.stdout.write(text);
  return new Promise((resolve) => prompt.question(question, (answer) => {
    prompt.close();
    if (hidden) process.stdout.write("\n");
    resolve(answer);
  }));
}

/** The updater key and its password in the environment, checked before any long build. */
async function signingKey() {
  // The key's contents, as the CI secret held them: `tauri signer sign` does not read a path here.
  const file = path.join(os.homedir(), ".tauri/screensway.key");
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !existsSync(file)) throw new Error(`Updater key not found at ${file}`);
  const key = process.env.TAURI_SIGNING_PRIVATE_KEY ?? readFileSync(file, "utf8").trim();
  const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? await ask("Updater key password: ", true);
  const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password };
  const scratch = mkdtempSync(path.join(os.tmpdir(), "screensway-sign-"));
  try {
    writeFileSync(path.join(scratch, "check"), "check");
    sign(path.join(scratch, "check"), env, "ignore");
  } catch {
    throw new Error("The updater key password is wrong.");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return env;
}

function sign(file, env, stdio = "inherit") {
  const result = spawnSync("pnpm", ["--filter", "@screensway/desktop", "exec", "tauri", "signer", "sign", file], { cwd: root, env, stdio });
  if (result.status !== 0 || !existsSync(`${file}.sig`)) throw new Error(`Signing ${path.basename(file)} failed`);
}

function requireMain() {
  if (output("git", ["status", "--porcelain"])) throw new Error("Commit or stash your changes first: a release is built from a clean main.");
  run("git", ["fetch", "origin", "main", "--tags"]);
  if (output("git", ["rev-parse", "HEAD"]) !== output("git", ["rev-parse", "origin/main"])) {
    throw new Error("HEAD is not origin/main: pull or push first, so both installers contain the same code.");
  }
}

async function macos() {
  if (process.platform !== "darwin") throw new Error("Run `macos` on the Mac.");
  requireMain();
  const env = await signingKey();
  run("pnpm", ["install", "--frozen-lockfile"]);
  run("pnpm", ["test"]);
  run("pnpm", ["typecheck"]);
  run("pnpm", ["build:macos"], { env });

  const bundle = path.join(root, "apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle");
  const dmg = path.join(bundle, "dmg", readdirSync(path.join(bundle, "dmg")).find((name) => name.endsWith(".dmg")));
  const updater = path.join(bundle, "macos", readdirSync(path.join(bundle, "macos")).find((name) => name.endsWith(".app.tar.gz")));
  if (!existsSync(`${updater}.sig`)) throw new Error("The updater bundle was not signed.");
  // The same checks as release.yml: a valid ad-hoc signature, both architectures, the icon.
  const mount = mkdtempSync(path.join(os.tmpdir(), "screensway-dmg-"));
  run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, dmg]);
  try {
    const app = path.join(mount, "ScreenSway.app");
    run("codesign", ["--verify", "--deep", "--strict", app]);
    for (const binary of ["screensway", "screensway-capture"]) run("lipo", [path.join(app, "Contents/MacOS", binary), "-verify_arch", "arm64", "x86_64"]);
    if (!existsSync(path.join(app, "Contents/Resources/icon.icns"))) throw new Error("The app has no icon.");
  } finally {
    run("hdiutil", ["detach", mount]);
  }

  mkdirSync(folder, { recursive: true });
  copyFileSync(dmg, path.join(folder, MAC_DMG));
  copyFileSync(updater, path.join(folder, MAC_UPDATER));
  copyFileSync(`${updater}.sig`, path.join(folder, `${MAC_UPDATER}.sig`));
  for (const file of [MAC_DMG, MAC_UPDATER]) console.log(`${file}: ${recordChecksum(path.join(folder, file))}`);
  console.log(`\nmacOS ${tag} is ready in ${folder}`);
}

function windowsBuild() {
  if (!windows) throw new Error("Run `windows` on the Windows PC.");
  requireMain();
  run("pnpm", ["install", "--frozen-lockfile"]);
  run("pnpm", ["setup:windows-speech"]);
  run("cargo", ["test", "--manifest-path", "native/windows-capture/Cargo.toml"]);
  run("pnpm", ["test"]);
  run("pnpm", ["typecheck"]);
  run("pnpm", ["build:capture:windows"]);
  run("cargo", ["test", "--lib", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml"]);
  // Real capture and export on this PC, which CI could only do on its own runner.
  run("node", ["scripts/test-windows-capture.mjs"]);
  run("pnpm", ["test:export:windows"]);
  run("pnpm", ["build:windows", "--config", "src-tauri/tauri.unsigned.conf.json"]);

  const nsis = path.join(root, "apps/desktop/src-tauri/target/release/bundle/nsis");
  const installers = readdirSync(nsis).filter((name) => name.endsWith(".exe") && name.includes(version));
  if (installers.length !== 1) throw new Error(`Expected one ${version} installer in ${nsis}`);
  mkdirSync(folder, { recursive: true });
  copyFileSync(path.join(nsis, installers[0]), path.join(folder, WINDOWS));
  console.log(`${WINDOWS}: ${recordChecksum(path.join(folder, WINDOWS))}`);
  console.log(`\nCopy ${path.join(folder, WINDOWS)} to release/${tag}/ on the Mac, then run \`publish\` there.`);
}

/** Builds the landing page with the browser version at /app/ and the updater feed of `release`. */
function buildSite(release, signatures, publishedAt) {
  const env = { ...process.env, VITE_ANALYTICS_URL: ANALYTICS_URL, VITE_DOWNLOADS_URL: DOWNLOADS_URL };
  run("pnpm", ["--filter", "@screensway/web", "build"], { env });
  run("pnpm", ["--filter", "@screensway/studio-web", "build"], { env });
  const dist = path.join(root, "apps/web/dist");
  cpSync(path.join(root, "apps/studio-web/dist"), path.join(dist, "app"), { recursive: true });

  const update = path.join(dist, "update");
  mkdirSync(update, { recursive: true });
  for (const file of [MAC_UPDATER, WINDOWS]) copyFileSync(path.join(signatures, `${file}.sig`), path.join(update, `${file}.sig`));
  run("node", ["scripts/build-update-manifest.mjs"], {
    env: {
      ...process.env,
      UPDATE_VERSION: release,
      UPDATE_BASE_URL: `${DOWNLOADS_URL}/${release}`,
      UPDATE_NOTES: `ScreenSway ${release}`,
      UPDATE_PUB_DATE: publishedAt,
    },
  });
  for (const file of [MAC_UPDATER, WINDOWS]) rmSync(path.join(update, `${file}.sig`));
  return path.join(update, "latest.json");
}

function uploadToken() {
  if (process.env.DOWNLOADS_UPLOAD_TOKEN) return process.env.DOWNLOADS_UPLOAD_TOKEN;
  const vars = path.join(root, "apps/downloads/.dev.vars");
  const token = existsSync(vars) && readFileSync(vars, "utf8").match(/^UPLOAD_TOKEN=["']?([^"'\n]+)/m)?.[1];
  if (!token) throw new Error("Set DOWNLOADS_UPLOAD_TOKEN (the downloads Worker's UPLOAD_TOKEN).");
  return token;
}

/** Puts the feed on the downloads Worker, which serves screensway.site/update/, then deploys the site. */
async function deploySite(feed) {
  const response = await fetch(`${DOWNLOADS_URL}/admin/update`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${uploadToken()}`, "Content-Type": "application/json" },
    body: readFileSync(feed),
  });
  if (!response.ok) throw new Error(`Uploading the updater feed failed: ${response.status} ${await response.text()}`);
  console.log(`Updater feed now offers ${(await response.json()).version}`);
  // The version matches apps/downloads' lockfile, as in web.yml.
  run("npx", ["--yes", "wrangler@4.149.0", "deploy", "--config", "apps/site/wrangler.toml"]);
}

async function publish() {
  if (process.platform !== "darwin") throw new Error("Run `publish` on the Mac, which holds the updater key.");
  requireMain();
  for (const file of [MAC_DMG, MAC_UPDATER, `${MAC_UPDATER}.sig`, WINDOWS]) {
    if (!existsSync(path.join(folder, file))) throw new Error(`${path.join(folder, file)} is missing: run \`macos\` here and \`windows\` on the PC first.`);
  }
  const installer = path.join(folder, WINDOWS);
  const recorded = existsSync(`${installer}.sha256`) && readFileSync(`${installer}.sha256`, "utf8").split(/\s+/)[0];
  if (recorded && recorded !== sha256(installer)) throw new Error(`${WINDOWS} changed while it was copied from the PC.`);
  if (!existsSync(`${installer}.sig`)) sign(installer, await signingKey());
  recordChecksum(installer);

  // The GitHub release keeps the files and their checksums; publish-downloads.mjs reads it.
  if (!output("git", ["tag", "--list", tag])) run("git", ["tag", tag]);
  if (output("git", ["rev-parse", `${tag}^{commit}`]) !== output("git", ["rev-parse", "HEAD"])) throw new Error(`${tag} already points at another commit.`);
  run("git", ["push", "origin", tag]);
  const assets = [MAC_DMG, MAC_UPDATER, WINDOWS].flatMap((file) => [file, `${file}.sha256`])
    .concat([`${MAC_UPDATER}.sig`, `${WINDOWS}.sig`])
    .map((file) => path.join(folder, file));
  if (spawnSync("gh", ["release", "view", tag], { cwd: root, stdio: "ignore" }).status === 0) {
    run("gh", ["release", "upload", tag, ...assets, "--clobber"]);
  } else {
    const notes = path.join(folder, "notes.md");
    const checksum = sha256(path.join(folder, MAC_DMG));
    writeFileSync(notes, readFileSync(path.join(root, ".github/release-notes.md"), "utf8").replace("__CHECKSUM__", checksum));
    run("gh", ["release", "create", tag, ...assets, "--title", `ScreenSway ${tag}`, "--notes-file", notes, "--verify-tag"]);
  }

  run("node", ["scripts/publish-downloads.mjs", tag, folder], {
    env: { ...process.env, DOWNLOADS_URL, DOWNLOADS_UPLOAD_TOKEN: uploadToken() },
  });
  const publishedAt = output("gh", ["release", "view", tag, "--json", "publishedAt", "--jq", ".publishedAt"]);
  await deploySite(buildSite(tag, folder, publishedAt));
  await check(tag);
}

/** Redeploys the site and the feed of the release the downloads Worker offers now. */
async function site() {
  const current = (await (await fetch(`${DOWNLOADS_URL}/current`)).json()).tag;
  const signatures = mkdtempSync(path.join(os.tmpdir(), "screensway-feed-"));
  try {
    run("gh", ["release", "download", current, "--pattern", `${MAC_UPDATER}.sig`, "--pattern", `${WINDOWS}.sig`, "--dir", signatures]);
    const publishedAt = output("gh", ["release", "view", current, "--json", "publishedAt", "--jq", ".publishedAt"]);
    await deploySite(buildSite(current, signatures, publishedAt));
  } finally {
    rmSync(signatures, { recursive: true, force: true });
  }
  await check(current);
}

async function check(release) {
  const current = await (await fetch(`${DOWNLOADS_URL}/current`, { cache: "no-store" })).json();
  const feed = await (await fetch(`https://screensway.site/update/latest.json?check=${Date.now()}`)).json();
  for (const file of [MAC_DMG, WINDOWS]) {
    const response = await fetch(`${DOWNLOADS_URL}/latest/${file}`, { method: "HEAD" });
    if (!response.ok) throw new Error(`${file} is not downloadable: ${response.status}`);
  }
  console.log(`\nDownloads offer ${current.tag}; the updater feed offers ${feed.version}.`);
  if (current.tag !== release || `v${feed.version.replace(/^v/, "")}` !== release) throw new Error(`Expected ${release} everywhere.`);
}

const steps = { macos, windows: windowsBuild, publish, site };
const step = steps[process.argv[2]];
if (!step) {
  console.error("Usage: node scripts/release-local.mjs macos|windows|publish|site");
  process.exit(1);
}
try {
  await step();
} catch (error) {
  console.error(`\n${error.message}`);
  process.exit(1);
}
