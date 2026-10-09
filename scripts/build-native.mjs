import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

if (process.platform !== "darwin") {
  process.exit(0);
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(repositoryRoot, "native/macos-capture");
const binariesPath = path.join(repositoryRoot, "apps/desktop/src-tauri/binaries");
const requestedTargetIndex = process.argv.indexOf("--target");
const requestedTarget = requestedTargetIndex >= 0 ? process.argv[requestedTargetIndex + 1] : undefined;
const targetTriple = requestedTarget
  ?? process.env.TAURI_ENV_TARGET_TRIPLE
  ?? execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();

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

function installBinary(source, target) {
  const targetPath = path.join(binariesPath, `screensway-capture-${target}`);
  copyFileSync(source, targetPath);
  chmodSync(targetPath, 0o755);
  return targetPath;
}

if (targetTriple === "universal-apple-darwin") {
  const armBinary = buildSwiftTarget("aarch64-apple-darwin");
  const intelBinary = buildSwiftTarget("x86_64-apple-darwin");
  installBinary(armBinary, "aarch64-apple-darwin");
  installBinary(intelBinary, "x86_64-apple-darwin");
  const result = spawnSync("lipo", ["-create", armBinary, intelBinary, "-output", destination], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
} else {
  installBinary(buildSwiftTarget(targetTriple), targetTriple);
}

chmodSync(destination, 0o755);
console.log(`Prepared ScreenSway capture sidecar: ${destination}`);

