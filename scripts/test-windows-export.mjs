// Deterministic native export checks, independent of the UI and an unlocked desktop.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") process.exit(0);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const triple = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
const helper = path.join(root, "apps/desktop/src-tauri/binaries", `screensway-capture-${triple}.exe`);
assert(existsSync(helper), "Build the native helper first.");
assert.equal(spawnSync("ffmpeg", ["-version"]).status, 0, "ffmpeg is required for export verification.");
// Exercise real Unicode paths, not only the Windows path conversion unit test.
const work = mkdtempSync(path.join(tmpdir(), "screensway-xuất video-"));
const run = (exe, args) => execFileSync(exe, args, { encoding: "utf8", timeout: 180_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
const probe = (p) => JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", p]));

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(file, width, height, color) {
  const chunk = (name, data) => {
    const type = Buffer.from(name); const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([size, type, data, checksum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixels.set(typeof color === "function" ? color(x, y) : color, y * (width * 4 + 1) + 1 + x * 4);
  }
  writeFileSync(file, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]));
}
const source = path.join(work, "source.mp4");
run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=60:d=3,drawbox=x=160:y=0:w=160:h=180:color=blue:t=fill,drawbox=x=0:y=0:w=320:h=180:color=yellow:t=fill:enable='lt(t,0.8)'", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3", "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);
const base = path.join(work, "base.png"), cursor = path.join(work, "cursor.png"), caption = path.join(work, "caption.png");
png(base, 640, 400, [20, 40, 80, 255]); png(cursor, 16, 16, [0, 255, 0, 255]); png(caption, 100, 20, [255, 255, 255, 255]);
const output = path.join(work, "export.mp4");
const job = {
  source: path.toNamespacedPath(source), output: path.toNamespacedPath(output), width: 640, height: 400, fps: 60, baseLayer: base, cursor,
  cursorHotspotX: 0, cursorHotspotY: 0, video: { x: 40, y: 40, width: 560, height: 315 },
  radius: 30, roundTopCorners: true, startMs: 800,
  frames: Array.from({ length: 60 }, (_, i) => [i < 30 ? 0 : 160, 0, i < 30 ? 320 : 160, 180, 200, 200, 24, 450, 200, 40, i < 30 ? 0 : 0.8]),
  captions: [{ startMs: 500, endMs: 1000, image: caption, x: 270, y: 370 }],
};
const jobPath = path.join(work, "job.json"); writeFileSync(jobPath, JSON.stringify(job));
let result;
try {
  result = JSON.parse(run(helper, ["--export", jobPath]));
} catch (error) {
  // Hosted Windows runners can expose D3D11 without its video interface. Only
  // this observed capability failure may be skipped, and only when requested
  // by CI. Pixel, codec, timing and other export errors must still fail.
  const message = String(error.stderr ?? "");
  if (process.env.SCREENSWAY_ALLOW_MISSING_VIDEO_DEVICE === "1"
    && message.includes("Opening the GPU video processor (ID3D11VideoDevice) failed:")
    && message.includes("(0x80004002)")) {
    console.log("::notice::Native GPU export checks skipped: this runner has no ID3D11VideoDevice. Run the strict test on a Windows PC with video-processing support.");
    process.exit(0);
  }
  throw error;
}
assert.equal(result.durationMs, 1000); assert.equal(result.width, 640); assert.equal(result.height, 400);
const metadata = probe(output);
const video = metadata.streams.find(s => s.codec_type === "video"), audio = metadata.streams.find(s => s.codec_type === "audio");
assert.equal(video.codec_name, "h264"); assert.equal(video.profile, "High"); assert.equal(video.r_frame_rate, "60/1");
assert.equal(audio.codec_name, "aac"); assert.equal(audio.channels, 2); assert.equal(audio.sample_rate, "48000");
assert(Math.abs(Number(metadata.format.duration) - 1) < 0.08);
function pixelAt(time, x, y) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", String(time), "-i", output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 2_000_000, windowsHide: true });
  return [...raw.subarray((y * 640 + x) * 3, (y * 640 + x) * 3 + 3)];
}
const near = (actual, expected, message) => assert(actual.every((v, i) => Math.abs(v - expected[i]) < 18), `${message}: ${actual}`);
near(pixelAt(0.25, 10, 10), [20, 40, 80], "Background is retained");
near(pixelAt(0.25, 180, 150), [255, 0, 0], "Trim skips the yellow opening and retains source position");
near(pixelAt(0.75, 180, 150), [0, 0, 255], "Edited crop pans into the blue source region");
near(pixelAt(0.25, 40, 40), [20, 40, 80], "Rounded corner reveals the background");
near(pixelAt(0.25, 210, 210), [0, 255, 0], "Cursor follows its render-plan position");
near(pixelAt(0.25, 300, 380), [20, 40, 80], "Caption is absent before its start");
near(pixelAt(0.75, 300, 380), [255, 255, 255], "Caption is visible at its scheduled time");

// Silent sources must remain exportable, and invalid plans must fail without creating output.
const silent = path.join(work, "silent.mp4"); run("ffmpeg", ["-v", "error", "-i", source, "-an", "-c:v", "copy", silent]);
job.source = silent; job.output = path.join(work, "silent-export.mp4"); writeFileSync(jobPath, JSON.stringify(job));
run(helper, ["--export", jobPath]); assert(!probe(job.output).streams.some(s => s.codec_type === "audio"));
job.width = 641; job.output = path.join(work, "invalid.mp4"); writeFileSync(jobPath, JSON.stringify(job));
assert.notEqual(spawnSync(helper, ["--export", jobPath], { windowsHide: true }).status, 0);
assert(!existsSync(job.output));
for (const [width, height] of [[1920,1080], [2560,1440], [3840,2160]]) {
  const background = path.join(work, `base-${height}.png`);
  png(background, width, height, [20,40,80,255]);
  const high = { ...job, width, height, source, baseLayer: background, output: path.join(work, `${height}p.mp4`),
    video: { x: 0, y: 0, width, height }, captions: [], frames: Array.from({ length: 6 }, () => [0,0,320,180,0,0,0,0,0,0,0]) };
  writeFileSync(jobPath, JSON.stringify(high)); run(helper, ["--export", jobPath]);
  const encoded = probe(high.output).streams.find(s => s.codec_type === "video");
  assert.equal(encoded.width, width); assert.equal(encoded.height, height); assert.equal(encoded.r_frame_rate, "60/1");
}
// A laptop-sized recording: H.264 pads 1366 × 766 to 1376 × 768, and reading the decoded rows
// with the wrong pitch shears the picture into diagonal stripes.
const odd = path.join(work, "odd.mp4");
run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=1366x766:r=60:d=1,drawbox=x=683:y=0:w=683:h=766:color=blue:t=fill", "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", odd]);
const oddBackground = path.join(work, "base-odd.png"); png(oddBackground, 1366, 766, [20,40,80,255]);
const oddJob = { ...job, width: 1366, height: 766, source: odd, baseLayer: oddBackground, output: path.join(work, "odd-export.mp4"), startMs: 0,
  sourceWidth: 0, sourceHeight: 0, video: { x: 0, y: 0, width: 1366, height: 766 }, radius: 0, captions: [], frames: Array.from({ length: 6 }, () => [0,0,1366,766,-100,-100,0,0,0,0,0]) };
writeFileSync(jobPath, JSON.stringify(oddJob)); run(helper, ["--export", jobPath]);
const oddFrame = execFileSync("ffmpeg", ["-v", "error", "-i", oddJob.output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 4_000_000, windowsHide: true });
const oddPixel = (x, y) => [...oddFrame.subarray((y * 1366 + x) * 3, (y * 1366 + x) * 3 + 3)];
for (const y of [20, 383, 745]) {
  near(oddPixel(600, y), [255, 0, 0], `Odd-sized source keeps its left half at row ${y}`);
  near(oddPixel(766, y), [0, 0, 255], `Odd-sized source keeps its right half at row ${y}`);
}
// A part played four times as fast: the picture is shorter and its sound is silence, so the
// sound after it stays in step and both tracks end together.
const speedTimes = Array.from({ length: 90 }, (_, i) => { const t = i * 1000 / 60; return t < 1000 ? t : 1000 + (t - 1000) * 4; });
const speedJob = { ...job, source, output: path.join(work, "speed.mp4"), startMs: 0, captions: [], sourceTimesMs: speedTimes,
  frames: speedTimes.map(() => [0,0,320,180,0,0,0,0,0,0,0]), sourceRanges: [{ startMs: 0, endMs: 1000 }, { startMs: 1000, endMs: 3000, rate: 4 }] };
writeFileSync(jobPath, JSON.stringify(speedJob)); run(helper, ["--export", jobPath]);
const speedStreams = probe(speedJob.output).streams;
const trackLength = (type) => Number(speedStreams.find(s => s.codec_type === type).duration);
assert(Math.abs(trackLength("video") - 1.5) < 0.05, `the 4× part is a quarter as long: ${trackLength("video")}`);
assert(Math.abs(trackLength("audio") - trackLength("video")) < 0.08, `sound and picture end together: ${trackLength("audio")}`);
const loudness = (from, to) => Number(/mean_volume: (-?[\d.]+) dB/.exec(spawnSync("ffmpeg", ["-hide_banner", "-i", speedJob.output, "-af", `atrim=${from}:${to},volumedetect`, "-f", "null", "-"], { encoding: "utf8", windowsHide: true }).stderr)[1]);
assert(loudness(0.2, 0.8) > -40, "the normal part keeps its sound");
assert(loudness(1.1, 1.4) < -60, "the faster part is silent");
// Music under the whole video: a one-second 1 kHz song at 44.1 kHz (resampled), not
// repeating, over the recording's 440 Hz tone; then repeating over a silent recording.
const song = path.join(work, "song.mp3");
run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=44100:duration=1", song]);
const at = (file, from, to, hz) => Number(/mean_volume: (-?[\d.]+) dB/.exec(spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-af", `atrim=${from}:${to},bandpass=f=${hz}:width_type=h:w=100,volumedetect`, "-f", "null", "-"], { encoding: "utf8", windowsHide: true }).stderr)?.[1] ?? -999);
const musicTimes = Array.from({ length: 150 }, (_, i) => i * 1000 / 60);
const musicJob = { ...job, source, startMs: 0, captions: [], sourceTimesMs: musicTimes, frames: musicTimes.map(() => [0,0,320,180,0,0,0,0,0,0,0]),
  sourceRanges: [{ startMs: 0, endMs: 2500 }], output: path.join(work, "music.mp4"), music: { path: song, volume: 1, loop: false } };
writeFileSync(jobPath, JSON.stringify(musicJob)); run(helper, ["--export", jobPath]);
assert(at(musicJob.output, 0.4, 0.8, 1000) > -35, "the music plays under the recording");
assert(at(musicJob.output, 1.3, 1.9, 1000) < at(musicJob.output, 0.4, 0.8, 1000) - 10, "a song that does not repeat ends");
assert(at(musicJob.output, 1.3, 1.9, 440) > -35, "the recording's own sound stays");
const silentMusic = { ...musicJob, source: silent, output: path.join(work, "music-silent.mp4"), music: { path: song, volume: 1, loop: true } };
writeFileSync(jobPath, JSON.stringify(silentMusic)); run(helper, ["--export", jobPath]);
const silentStreams = probe(silentMusic.output).streams;
assert(silentStreams.some(s => s.codec_type === "audio"), "a silent recording gets a sound track for its music");
assert(at(silentMusic.output, 1.3, 1.9, 1000) > -35, "repeating music keeps playing");
console.log(`Windows native export checks passed. Artifacts: ${work}`);
