import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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

async function record(source, name, commands, { systemAudio = false, microphone = false, extra = [] } = {}) {
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
    ...extra,
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
  // Shortcut keys are only recorded when asked; the file is always there, so projects look alike.
  assert.deepEqual(JSON.parse(readFileSync(path.join(projectPath, "metadata/keystrokes.json"), "utf8")), result.keystrokes);
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

{
  // A region of the display is cropped by ScreenCaptureKit, so nothing outside it is stored.
  const regionCapture = await record(display, "Region", [{ afterMs: 1_200, value: "stop" }], { extra: ["--region", "0.25,0.25,0.5,0.5"] });
  const ratio = regionCapture.result.width / displayCapture.result.width;
  assert(ratio > 0.45 && ratio < 0.55, `the region is half the display's width (${ratio.toFixed(2)})`);
  assert(Math.abs(regionCapture.result.height / displayCapture.result.height - 0.5) < 0.05, "the region is half the display's height");
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
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=white:s=100x40", "-frames:v", "1", path.join(exportRoot, "caption.png")]);
  const output = path.join(exportRoot, "out.mp4");
  const job = {
    source, output,
    width: 640, height: 400, fps: 60,
    baseLayer: path.join(exportRoot, "base.png"), cursor: path.join(exportRoot, "cursor.png"),
    cursorHotspotX: 0, cursorHotspotY: 0,
    video: { x: 0, y: 0, width: 640, height: 400 }, radius: 0, roundTopCorners: true,
    startMs: 3_000,
    // A caption on the exported timeline, from 1.0 to 2.0 s, top-left at (20, 300).
    captions: [{ startMs: 1_000, endMs: 2_000, image: path.join(exportRoot, "caption.png"), x: 20, y: 300 }],
    frames: Array.from({ length: 180 }, () => [0, 0, 640, 400, 0, 0, 0, 0, 0, 0, 0]),
  };
  writeFileSync(path.join(exportRoot, "job.json"), JSON.stringify(job));
  execFileSync(binaryPath, ["--export", path.join(exportRoot, "job.json")], { stdio: ["ignore", "pipe", "pipe"] });

  const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", output], { encoding: "utf8" }));
  assert(Math.abs(duration - 3) < 0.05, `Trimmed export should last 3 s, got ${duration}`);
  const pixel = (seconds, x = 320, y = 200) => [...execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(seconds), "-i", output, "-frames:v", "1", "-vf", `crop=2:2:${x}:${y},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ])];
  const isWhite = ([r, g, b]) => r > 230 && g > 230 && b > 230;
  assert(isWhite(pixel(1.5, 70, 320)), "The caption is missing while it should be shown.");
  assert(!isWhite(pixel(0.8, 70, 320)) && !isWhite(pixel(2.3, 70, 320)), "The caption shows outside its time.");
  assert(!isWhite(pixel(1.5, 70, 260)), "The caption is drawn in the wrong place.");
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

// Captions: on-device speech recognition in Vietnamese and English. macOS asks the
// *responsible* app for its usage description, which a terminal does not have, so the
// helper runs inside a small temporary app launched through LaunchServices, as it does
// inside ScreenSway.app. Needs the Speech Recognition permission, so it only runs when asked.
if (process.env.SCREENSWAY_TEST_CAPTIONS === "1") {
  const captionRoot = path.join(testRoot, "Captions");
  const app = path.join(captionRoot, "ScreenSway Caption Test.app");
  mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  copyFileSync(binaryPath, path.join(app, "Contents/MacOS/screensway-capture"));
  writeFileSync(path.join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.screensway.captiontest</string>
<key>CFBundleName</key><string>ScreenSway Caption Test</string>
<key>CFBundleExecutable</key><string>run</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>NSSpeechRecognitionUsageDescription</key><string>ScreenSway test: checks on-device captions.</string>
</dict></plist>`);
  const cases = [
    { locale: "vi-VN", voice: "Linh", text: "Xin chào các bạn. Hôm nay mình sẽ hướng dẫn cách quay màn hình.", expect: ["chào", "màn hình"] },
    { locale: "en-US", voice: "Samantha", text: "Hello everyone. Today I will show you how to record your screen.", expect: ["hello", "screen"] },
  ];
  const runner = ["#!/bin/zsh", 'helper="$(dirname "$0")/screensway-capture"'];
  for (const { locale, voice, text } of cases) {
    const speech = path.join(captionRoot, `${locale}.aiff`);
    const video = path.join(captionRoot, `${locale}.mp4`);
    execFileSync("say", ["-v", voice, "-o", speech, text]);
    // Two seconds of silence first, so the timings must be offset correctly.
    execFileSync("ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi", "-i", "color=black:s=320x200:r=30:d=12",
      "-i", speech, "-filter_complex", "[1:a]adelay=2000|2000,apad[a]", "-map", "0:v", "-map", "[a]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video,
    ]);
    const base = path.join(captionRoot, locale);
    runner.push(`"$helper" --transcribe '${video}' --locale ${locale} --output '${base}.json' > '${base}.out' 2> '${base}.err'; echo $? > '${base}.status'`);
  }
  writeFileSync(path.join(app, "Contents/MacOS/run"), `${runner.join("\n")}\n`);
  chmodSync(path.join(app, "Contents/MacOS/run"), 0o755);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app]);
  execFileSync("open", ["-W", "-n", app]);

  for (const { locale, expect } of cases) {
    const base = path.join(captionRoot, locale);
    const status = readFileSync(`${base}.status`, "utf8").trim();
    assert.equal(status, "0", `${locale} captions failed: ${readFileSync(`${base}.err`, "utf8").replace(/SCREENSWAY_PROGRESS \d+\n/g, "")}`);
    const result = JSON.parse(readFileSync(`${base}.out`, "utf8"));
    const transcript = result.words.map((word) => word.text).join(" ").toLowerCase();
    for (const fragment of expect) assert(transcript.includes(fragment), `${locale} captions miss "${fragment}": ${transcript}`);
    assert(result.words[0].startMs >= 1_500, `${locale} captions start before the speech does.`);
    assert(result.words.every((word, index) => word.endMs >= word.startMs && (index === 0 || word.startMs >= result.words[index - 1].startMs)));
    assert(result.words.at(-1).endMs <= 12_000);
    assert.deepEqual(JSON.parse(readFileSync(`${base}.json`, "utf8")), result);
  }
} else {
  console.log("Caption tests skipped (set SCREENSWAY_TEST_CAPTIONS=1 after allowing Speech Recognition).");
}

console.log(`macOS capture integration tests passed. Artifacts: ${testRoot}`);
