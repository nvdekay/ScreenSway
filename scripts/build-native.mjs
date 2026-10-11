import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
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
  const manifest = path.join(repositoryRoot, "native/windows-capture/Cargo.toml");
  const crossTarget = targetTriple === hostTriple ? [] : ["--target", targetTriple];
  const result = spawnSync("cargo", ["build", "--release", "--manifest-path", manifest, ...crossTarget], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const built = path.join(
    repositoryRoot,
    "native/windows-capture/target",
    ...(crossTarget.length > 0 ? [targetTriple] : []),
    "release/screensway-capture.exe",
  );
  mkdirSync(binariesPath, { recursive: true });
  const destination = path.join(binariesPath, `screensway-capture-${targetTriple}.exe`);
  copyFileSync(built, destination);
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

