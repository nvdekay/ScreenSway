import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

if (process.platform !== "darwin" && process.platform !== "win32") {
  process.exit(0);
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(repositoryRoot, "native/macos-capture");
const binariesPath = path.join(repositoryRoot, "apps/desktop/src-tauri/binaries");
const requestedTargetIndex = process.argv.indexOf("--target");
const requestedTarget = requestedTargetIndex >= 0 ? process.argv[requestedTargetIndex + 1] : undefined;
const hostTriple = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
const targetTriple = requestedTarget ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTriple;

// Windows: the Rust helper in native/windows-capture, with the same command line as the Swift one.
if (process.platform === "win32") {
  const { verifyModel } = await import("./setup-windows-speech.mjs");
  if (!await verifyModel()) {
    throw new Error("Windows speech model is missing or damaged. Run pnpm setup:windows-speech before building.");
  }
  const manifest = path.join(repositoryRoot, "native/windows-capture/Cargo.toml");
  const crossTarget = targetTriple === hostTriple ? [] : ["--target", targetTriple];
  const result = spawnSync("cargo", ["build", "--release", "--message-format=json-render-diagnostics", "--manifest-path", manifest, ...crossTarget], {
    cwd: repositoryRoot,
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  // Inspect the exact dependency build used by Cargo, including cache hits.
  // A nominal Release build is insufficient: cmake-rs can omit native /O2.
  if (targetTriple === "x86_64-pc-windows-msvc") {
    const speechBuild = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line))
      .find(message => message.reason === "build-script-executed" && message.package_id.includes("whisper-rs-sys"));
    if (!speechBuild) throw new Error("Cannot verify the native speech compiler settings.");
    const cache = readFileSync(path.join(speechBuild.out_dir, "build/CMakeCache.txt"), "utf8");
    for (const language of ["C", "CXX"]) {
      const flags = cache.match(new RegExp(`^CMAKE_${language}_FLAGS_RELEASE:STRING=(.*)$`, "m"))?.[1] ?? "";
      if (!/(?:^|\s)\/O2(?:\s|$)/.test(flags)) {
        throw new Error("Native speech optimization is missing. Clear whisper-rs-sys build artifacts and rebuild with .cargo/windows-speech.cmake.");
      }
    }
  }
  const built = path.join(
    repositoryRoot,
    "native/windows-capture/target",
    ...(crossTarget.length > 0 ? [targetTriple] : []),
    "release/screensway-capture.exe",
  );
  mkdirSync(binariesPath, { recursive: true });
  const destination = path.join(binariesPath, `screensway-capture-${targetTriple}.exe`);
  // Windows locks a running sidecar. An unchanged build can still prepare the app
  // while an export/transcription finishes; do not overwrite an identical executable.
  if (!existsSync(destination) || !readFileSync(built).equals(readFileSync(destination))) {
    copyFileSync(built, destination);
  }
  console.log(`Prepared ScreenSway capture sidecar: ${destination}`);
  process.exit(0);
}

const swiftTargets = {
  "aarch64-apple-darwin": {
    triple: "arm64-apple-macosx15.0",
    outputDirectory: "arm64-apple-macosx",
  },
  "x86_64-apple-darwin": {
    triple: "x86_64-apple-macosx15.0",
    outputDirectory: "x86_64-apple-macosx",
  },
};

function buildSwiftTarget(target) {
  const configuration = swiftTargets[target];
  if (!configuration) {
    throw new Error(`Unsupported macOS capture target: ${target}`);
  }

  const result = spawnSync(
    "swift",
    [
      "build",
      "--configuration", "release",
      "--triple", configuration.triple,
      "--package-path", packagePath,
    ],
    { stdio: "inherit" },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);

  return path.join(
    packagePath,
    ".build",
    configuration.outputDirectory,
    "release",
    "screensway-capture",
  );
}

mkdirSync(binariesPath, { recursive: true });
const destination = path.join(binariesPath, `screensway-capture-${targetTriple}`);

// Local symbols are only useful for debugging; dropping them roughly halves the sidecar.
function stripSymbols(binary) {
  const result = spawnSync("strip", ["-x", binary], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// An ad-hoc signature binds the embedded Info.plist to the binary. Without it macOS
// ignores the usage descriptions and ends the helper when it asks for speech recognition.
// Release bundles are signed again by Tauri with the app's entitlements.
function signBinary(binary) {
  const result = spawnSync("codesign", ["--force", "--sign", "-", binary], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function installBinary(source, target) {
  const targetPath = path.join(binariesPath, `screensway-capture-${target}`);
  copyFileSync(source, targetPath);
  chmodSync(targetPath, 0o755);
  stripSymbols(targetPath);
  signBinary(targetPath);
  return targetPath;
}

if (targetTriple === "universal-apple-darwin") {
  const armBinary = buildSwiftTarget("aarch64-apple-darwin");
  const intelBinary = buildSwiftTarget("x86_64-apple-darwin");
  const armInstalled = installBinary(armBinary, "aarch64-apple-darwin");
  const intelInstalled = installBinary(intelBinary, "x86_64-apple-darwin");
  const result = spawnSync("lipo", ["-create", armInstalled, intelInstalled, "-output", destination], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  signBinary(destination);
} else {
  installBinary(buildSwiftTarget(targetTriple), targetTriple);
}

chmodSync(destination, 0o755);
console.log(`Prepared ScreenSway capture sidecar: ${destination}`);

