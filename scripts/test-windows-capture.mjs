// Real capture test for the Windows helper: lists sources, records the main display (with a
// pause) and a window, and checks the project files. With ffprobe on PATH it also checks the
// video stream. Run it on a Windows machine with an unlocked desktop.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

if (process.platform !== "win32") {
  console.log("Windows capture integration tests skipped on this platform.");
  process.exit(0);
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetTriple = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
const binaryPath = path.join(repositoryRoot, "apps/desktop/src-tauri/binaries", `screensway-capture-${targetTriple}.exe`);
assert(existsSync(binaryPath), `Capture sidecar is missing: ${binaryPath}`);

const sources = JSON.parse(execFileSync(binaryPath, ["--list-sources"], { encoding: "utf8" }));
const display = sources.find((source) => source.kind === "display");
const windowSource = sources.find((source) => source.kind === "window");
assert(display, "At least one display capture source is required.");
assert(
  sources.every((source) => source.id && source.name && source.width > 0 && source.height > 0 && source.pixelScale >= 1),
  "Each source needs an id, a name, a size and a pixel scale.",
);
console.log(`Sources: ${sources.length} (${sources.filter((source) => source.kind === "window").length} windows)`);

const hasFfprobe = spawnSync("ffprobe", ["-version"]).status === 0;
if (!hasFfprobe) console.log("ffprobe not found; video stream checks skipped.");

const testRoot = mkdtempSync(path.join(tmpdir(), "screensway-capture-test-"));

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function record(source, name, commands, audioArguments = []) {
  const projectPath = path.join(testRoot, `${name}.screensway`);
  const controlPath = path.join(projectPath, ".capture-control");
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(controlPath, "recording");

  const child = spawn(binaryPath, [
    "--output", projectPath,
    "--control", controlPath,
    "--source-kind", source.kind,
    "--source-id", source.id,
    "--duration", "30",
    ...audioArguments,
  ], { windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  // The timer in the app starts at SCREENSWAY_READY, so the test does too.
  const readyAt = Date.now() + 15_000;
  while (!stderr.includes("SCREENSWAY_READY")) {
    assert(child.exitCode === null, `${name} helper exited early: ${stderr}`);
    assert(Date.now() < readyAt, `${name} capture did not start: ${stderr}`);
    await delay(20);
  }
  for (const command of commands) {
    await delay(command.afterMs);
    writeFileSync(controlPath, command.value);
  }

  const exitCode = await new Promise((resolve, reject) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, stderr || `${name} capture exited with ${exitCode}`);

  const result = JSON.parse(stdout);
  const manifest = JSON.parse(readFileSync(path.join(projectPath, "project.json"), "utf8"));
  const pointerEvents = JSON.parse(readFileSync(path.join(projectPath, "metadata/pointer-events.json"), "utf8"));
  const videoPath = path.join(projectPath, "media/screen.mp4");

  assert.equal(path.resolve(result.projectPath), path.resolve(projectPath));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.durationMs, result.durationMs);
  assert.equal(manifest.canvas.width, result.width);
  assert.equal(manifest.canvas.height, result.height);
  assert.equal(manifest.media.screen, "media/screen.mp4");
  assert.match(manifest.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual(pointerEvents, result.pointerEvents);
  assert(existsSync(videoPath), `${name} video was not created.`);
  assert(statSync(videoPath).size > 1_000, `${name} video is empty.`);
  assert(existsSync(path.join(projectPath, "media/thumbnail.jpg")), `${name} thumbnail was not written.`);
  assert(result.width > 0 && result.width % 2 === 0, `${name} width must be positive and even.`);
  assert(result.height > 0 && result.height % 2 === 0, `${name} height must be positive and even.`);
  assert(
    result.pointerEvents.every((event) => event.timeMs <= result.durationMs + 100),
    `${name} pointer metadata exceeds the project duration.`,
  );

  let videoDurationMs;
  if (hasFfprobe) {
    const probe = JSON.parse(execFileSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,profile,width,height",
        "-show_entries", "format=duration", "-of", "json", videoPath],
      { encoding: "utf8" },
    ));
    assert.equal(probe.streams[0].codec_name, "h264");
    assert.equal(probe.streams[0].profile, "High", `${name} should use the H.264 High profile.`);
    assert.equal(probe.streams[0].width, result.width);
    assert.equal(probe.streams[0].height, result.height);
    videoDurationMs = Number(probe.format.duration) * 1_000;
  }
  const stats = JSON.parse(readFileSync(path.join(projectPath, "metadata/capture-stats.json"), "utf8"));
  assert(stats.framesWritten > 0, `${name} wrote no frames.`);
  console.log(`${name}: ${result.width}×${result.height}, ${result.durationMs} ms, video ${videoDurationMs ?? "?"} ms, ${result.pointerEvents.length} pointer events`);
  console.log(`  ${stats.encoder}; ${stats.framesReceived} frames received, ${stats.framesWritten} written; ${stats.averageFrameMs.toFixed(2)} ms per frame, slowest ${stats.slowestFrameMs.toFixed(1)} ms, ${stats.slowFrames} slow`);
  return { result, videoDurationMs, videoPath };
}

const displayCapture = await record(display, "Display", [
  { afterMs: 1_200, value: "pause" },
  { afterMs: 900, value: "recording" },
  { afterMs: 1_200, value: "stop" },
]);
assert(displayCapture.result.durationMs >= 1_900 && displayCapture.result.durationMs <= 2_900);
if (displayCapture.videoDurationMs !== undefined) {
  // The video is extended to the stop time, so it matches the pointer timeline closely.
  assert(Math.abs(displayCapture.videoDurationMs - displayCapture.result.durationMs) <= 60);
}

if (windowSource) {
  const windowCapture = await record(windowSource, "Window", [{ afterMs: 1_500, value: "stop" }]);
  assert(windowCapture.result.durationMs >= 1_000 && windowCapture.result.durationMs <= 2_000);
  if (windowCapture.videoDurationMs !== undefined) {
    assert(Math.abs(windowCapture.videoDurationMs - windowCapture.result.durationMs) <= 60);
  }
} else {
  console.log("Window capture test skipped because no eligible window is open.");
}

const microphones = JSON.parse(execFileSync(binaryPath, ["--list-microphones"], { encoding: "utf8" }));
assert(microphones.every(device => device.id && device.name && typeof device.isDefault === "boolean"));
console.log(`Microphones: ${microphones.length}`);

function checkAudio(recording) {
  if (!hasFfprobe) return;
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_streams", "-of", "json", recording.videoPath], { encoding: "utf8" }));
  assert.equal(probe.streams.length, 1, "Capture must mix into one playable audio track.");
  assert.equal(probe.streams[0].codec_name, "aac");
  assert.equal(probe.streams[0].channels, 2);
  assert.equal(probe.streams[0].sample_rate, "48000");
  assert(Math.abs(Number(probe.streams[0].duration) * 1000 - recording.result.durationMs) < 100, "Audio and video must retain the same pause-free duration.");
}
if (process.env.SCREENSWAY_TEST_AUDIO !== "0") {
  let playback;
  try {
    if (spawnSync("ffmpeg", ["-version"]).status === 0) {
      const tone = path.join(testRoot, "tone.wav");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4", "-af", "volume=0.25", tone]);
      const literal = tone.replaceAll("'", "''");
      playback = spawn("powershell.exe", ["-NoProfile", "-Command", `$tone = New-Object System.Media.SoundPlayer '${literal}'; $tone.PlayLooping(); Start-Sleep -Seconds 20`], { windowsHide: true, stdio: "ignore" });
      await delay(500);
    }
    const systemAudio = await record(display, "SystemAudio", [
      { afterMs: 800, value: "pause" }, { afterMs: 500, value: "recording" }, { afterMs: 800, value: "stop" },
    ], ["--system-audio"]);
    checkAudio(systemAudio);
    if (playback) {
      const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", systemAudio.videoPath, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { maxBuffer: 2_000_000, windowsHide: true });
      let energy = 0, count = 0;
      for (let offset = 48000; offset + 4 <= Math.min(pcm.length, 240000); offset += 4) { const x = pcm.readFloatLE(offset); energy += x*x; count++; }
      const rms = Math.sqrt(energy / Math.max(1, count));
      assert(rms > 0.0001, `System loopback track must contain the played tone, not silence (RMS ${rms}).`);
      console.log(`  Loopback tone RMS: ${rms.toFixed(5)}`);
    }
  } finally { playback?.kill(); }
  if (microphones.length && process.env.SCREENSWAY_TEST_MICROPHONE !== "0") {
    const mic = microphones.find(device => device.isDefault) ?? microphones[0];
    const mixedAudio = await record(display, "MixedAudio", [{ afterMs: 1500, value: "stop" }], ["--system-audio", "--microphone", mic.id]);
    checkAudio(mixedAudio);
  }
}

console.log(`Windows capture integration tests passed. Artifacts: ${testRoot}`);
