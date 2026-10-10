import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

if (process.platform !== "darwin") {
  console.log("macOS capture integration tests skipped on this platform.");
  process.exit(0);
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetTriple = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
const binaryPath = path.join(
  repositoryRoot,
  "apps/desktop/src-tauri/binaries",
  `screensway-capture-${targetTriple}`,
);
assert(existsSync(binaryPath), `Capture sidecar is missing: ${binaryPath}`);

const sources = JSON.parse(execFileSync(binaryPath, ["--list-sources"], { encoding: "utf8" }));
const display = sources.find((source) => source.kind === "display");
const windowSource = sources.find((source) => source.kind === "window");
assert(display, "At least one display capture source is required.");

const testRoot = mkdtempSync(path.join(tmpdir(), "screensway-capture-test-"));

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function record(source, name, commands, { systemAudio = false } = {}) {
  const projectPath = path.join(testRoot, `${name}.screensway`);
  const controlPath = path.join(projectPath, ".capture-control");
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(controlPath, "recording");

  const child = spawn(binaryPath, [
    "--output", projectPath,
    "--control", controlPath,
    "--source-kind", source.kind,
    "--source-id", source.id,
    ...(systemAudio ? ["--system-audio"] : []),
  ]);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  for (const command of commands) {
    await delay(command.afterMs);
    writeFileSync(controlPath, command.value);
  }

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, stderr || `${name} capture exited with ${exitCode}`);

  const result = JSON.parse(stdout);
  const manifest = JSON.parse(readFileSync(path.join(projectPath, "project.json"), "utf8"));
  const pointerEvents = JSON.parse(
    readFileSync(path.join(projectPath, "metadata/pointer-events.json"), "utf8"),
  );
  const videoPath = path.join(projectPath, "media/screen.mp4");

  assert.equal(result.projectPath, projectPath);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.durationMs, result.durationMs);
  assert.equal(manifest.canvas.width, result.width);
  assert.equal(manifest.canvas.height, result.height);
  assert.equal(manifest.media.screen, "media/screen.mp4");
  assert.deepEqual(pointerEvents, result.pointerEvents);
  assert(existsSync(videoPath), `${name} video was not created.`);
  assert(!existsSync(path.join(projectPath, "media/segments")), `${name} left temporary segments behind.`);
  assert(result.width > 0 && result.width % 2 === 0, `${name} width must be positive and even.`);
  assert(result.height > 0 && result.height % 2 === 0, `${name} height must be positive and even.`);
  assert(result.pointerEvents.length > 0, `${name} did not capture pointer metadata.`);
  assert(
    result.pointerEvents.every((event) => event.timeMs <= result.durationMs + 100),
    `${name} pointer metadata exceeds the project duration.`,
  );

  const probe = JSON.parse(execFileSync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,profile,width,height,bit_rate",
      "-show_entries", "format=duration",
      "-of", "json",
      videoPath,
    ],
    { encoding: "utf8" },
  ));
  assert.equal(probe.streams[0].codec_name, "h264");
  // ScreenSway encodes itself instead of using SCRecordingOutput's low default bitrate.
  assert.equal(probe.streams[0].profile, "High", `${name} should use the H.264 High profile.`);
  assert.equal(probe.streams[0].width, result.width);
  assert.equal(probe.streams[0].height, result.height);

  const audioStreams = JSON.parse(execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name,sample_rate,channels,duration", "-of", "json", videoPath],
    { encoding: "utf8" },
  )).streams;
  if (systemAudio) {
    assert.equal(audioStreams.length, 1, `${name} should contain a system audio track.`);
    assert.equal(audioStreams[0].codec_name, "aac");
    assert.equal(Number(audioStreams[0].sample_rate), 48_000);
    assert.equal(audioStreams[0].channels, 2);
    // Audio shares the video clock, including the paused interval that was cut.
    assert(Math.abs(Number(audioStreams[0].duration) * 1_000 - Number(probe.format.duration) * 1_000) <= 250);
  } else {
    assert.equal(audioStreams.length, 0, `${name} should not contain audio unless requested.`);
  }

  return { result, videoDurationMs: Number(probe.format.duration) * 1_000 };
}

const displayCapture = await record(display, "Display", [
  { afterMs: 1_200, value: "pause" },
  { afterMs: 900, value: "recording" },
  { afterMs: 1_200, value: "stop" },
], { systemAudio: true });
assert(displayCapture.result.durationMs >= 1_900 && displayCapture.result.durationMs <= 2_900);
// The video is extended to the stop time, so it matches the pointer timeline closely.
assert(Math.abs(displayCapture.videoDurationMs - displayCapture.result.durationMs) <= 60);

if (windowSource) {
  const windowCapture = await record(windowSource, "Window", [
    { afterMs: 1_500, value: "stop" },
  ]);
  assert(windowCapture.result.durationMs >= 1_000 && windowCapture.result.durationMs <= 2_000);
  assert(windowCapture.videoDurationMs > 0);
  assert(Math.abs(windowCapture.videoDurationMs - windowCapture.result.durationMs) <= 60);
} else {
  console.log("Window capture test skipped because no eligible window is open.");
}

console.log(`macOS capture integration tests passed. Artifacts: ${testRoot}`);
