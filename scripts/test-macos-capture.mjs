import { execFileSync, spawn, spawnSync } from "node:child_process";
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
const microphones = JSON.parse(execFileSync(binaryPath, ["--list-microphones"], { encoding: "utf8" }));
assert(Array.isArray(microphones), "Microphones must be listed as an array.");
assert(microphones.every((microphone) => microphone.id && microphone.name), "Each microphone needs an id and a name.");
assert(microphones.filter((microphone) => microphone.isDefault).length <= 1, "Only one microphone can be the default.");
const display = sources.find((source) => source.kind === "display");
const windowSource = sources.find((source) => source.kind === "window");
assert(display, "At least one display capture source is required.");

const testRoot = mkdtempSync(path.join(tmpdir(), "screensway-capture-test-"));

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function record(source, name, commands, { systemAudio = false, microphone = false } = {}) {
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
    ...(microphone ? ["--microphone", "default"] : []),
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
  if (systemAudio || microphone) {
    // System audio and the microphone are mixed into one track that every player can play.
    assert.equal(audioStreams.length, 1, `${name} should contain exactly one audio track.`);
    assert.equal(audioStreams[0].codec_name, "aac");
    assert.equal(Number(audioStreams[0].sample_rate), 48_000);
    assert.equal(audioStreams[0].channels, 2);
    // Audio shares the video clock, including the paused interval that was cut.
    assert(Math.abs(Number(audioStreams[0].duration) * 1_000 - Number(probe.format.duration) * 1_000) <= 250);
  } else {
    assert.equal(audioStreams.length, 0, `${name} should not contain audio unless requested.`);
  }
  if (microphone) {
    // A live microphone always hears some room noise; an all-zero track means it was not captured.
    const levels = spawnSync(
      "ffmpeg",
      ["-v", "info", "-i", videoPath, "-map", "0:a", "-af", "astats", "-f", "null", "-"],
      { encoding: "utf8" },
    ).stderr;
    const peak = Number(/Overall[\s\S]*?Peak level dB: (-?[\d.]+|-inf)/.exec(levels)?.[1] ?? "-inf");
    assert(peak > -90, `${name} microphone audio is silent.`);
    assert(peak <= 0.5, `${name} microphone audio clips at ${peak} dB.`);
  }

  return { result, videoDurationMs: Number(probe.format.duration) * 1_000 };
}

const hasMicrophone = microphones.length > 0 && process.env.SCREENSWAY_TEST_MICROPHONE !== "0";
if (!hasMicrophone) console.log("Microphone capture tests skipped.");

const displayCapture = await record(display, "Display", [
  { afterMs: 1_200, value: "pause" },
  { afterMs: 900, value: "recording" },
  { afterMs: 1_200, value: "stop" },
], { systemAudio: true, microphone: hasMicrophone });
assert(displayCapture.result.durationMs >= 1_900 && displayCapture.result.durationMs <= 2_900);
// The video is extended to the stop time, so it matches the pointer timeline closely.
assert(Math.abs(displayCapture.videoDurationMs - displayCapture.result.durationMs) <= 60);

if (hasMicrophone) {
  const microphoneCapture = await record(display, "Microphone", [
    { afterMs: 1_500, value: "stop" },
  ], { microphone: true });
  assert(Math.abs(microphoneCapture.videoDurationMs - microphoneCapture.result.durationMs) <= 60);
}

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


// Export: a trimmed start must pick up video and audio at the same source moment.
{
  const exportRoot = path.join(testRoot, "Export");
  mkdirSync(exportRoot, { recursive: true });
  const source = path.join(exportRoot, "source.mp4");
  // Each second has its own green level (25 per second) and the red channel flips every second;
  // a 1 kHz beep plays only from 4.0 to 4.5 s.
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=black:s=640x400:r=60:d=8,format=rgb24,geq=r='mod(floor(T),2)*255':g='floor(T)*25':b=0",
    "-f", "lavfi", "-i", "aevalsrc='if(between(t,4,4.5),0.5*sin(2*PI*1000*t),0)':s=48000:d=8",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "120", "-c:a", "aac", "-shortest", source,
  ]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=black:s=640x400", "-frames:v", "1", path.join(exportRoot, "base.png")]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=white:s=16x16", "-frames:v", "1", path.join(exportRoot, "cursor.png")]);
  const output = path.join(exportRoot, "out.mp4");
  const job = {
    source, output,
    width: 640, height: 400, fps: 60,
    baseLayer: path.join(exportRoot, "base.png"), cursor: path.join(exportRoot, "cursor.png"),
    cursorHotspotX: 0, cursorHotspotY: 0,
    video: { x: 0, y: 0, width: 640, height: 400 }, radius: 0, roundTopCorners: true,
    startMs: 3_000,
    frames: Array.from({ length: 180 }, () => [0, 0, 640, 400, 0, 0, 0, 0, 0, 0, 0]),
  };
  writeFileSync(path.join(exportRoot, "job.json"), JSON.stringify(job));
  execFileSync(binaryPath, ["--export", path.join(exportRoot, "job.json")], { stdio: ["ignore", "pipe", "pipe"] });

  const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", output], { encoding: "utf8" }));
  assert(Math.abs(duration - 3) < 0.05, `Trimmed export should last 3 s, got ${duration}`);
  const pixel = (seconds) => [...execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(seconds), "-i", output, "-frames:v", "1", "-vf", "crop=2:2:320:200,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ])];
  // Output 0.5 s is source 3.5 s (red on, green 75); output 1.5 s is source 4.5 s (red off,
  // green 100). Colors shift a little between color spaces, so the neighbors are told apart
  // by the red parity and the green order: 2.5 s has green 50, 5.5 s has green 125.
  const [r1, g1] = pixel(0.5);
  const [r2, g2] = pixel(1.5);
  assert(r1 > 200 && g1 > 62 && g1 < 108, `Export frame at 0.5 s shows the wrong source time (${r1}, ${g1}).`);
  assert(r2 < 60 && g2 > 85 && g2 < 125, `Export frame at 1.5 s shows the wrong source time (${r2}, ${g2}).`);
  // The beep (source 4.0–4.5 s) must now play at 1.0–1.5 s.
  const loudness = (from, to) => {
    const stats = spawnSync("ffmpeg", ["-v", "info", "-ss", String(from), "-t", String(to - from), "-i", output, "-map", "0:a", "-af", "astats", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const level = /Overall[\s\S]*?RMS level dB: (-?[\d.]+|-inf)/.exec(stats)?.[1];
    return level === undefined || level === "-inf" ? -200 : Number(level);
  };
  assert(loudness(1.1, 1.4) > -20, "The beep is missing from the trimmed export.");
  assert(loudness(0.2, 0.8) < -60 && loudness(1.7, 2.8) < -60, "The trimmed export's audio is misaligned.");
}

console.log(`macOS capture integration tests passed. Artifacts: ${testRoot}`);
