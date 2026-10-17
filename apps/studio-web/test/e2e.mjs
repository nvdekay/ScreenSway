// End to end in a real Chromium browser (Edge by default, BROWSER=chrome for Chrome): record,
// prepare, edit and export, with the shared screen replaced by an animated canvas that has a
// pointer moving between stops, plus a tone as system audio. The save dialog writes to the
// browser's private storage, where the test reads the MP4 back.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import { chromium } from "playwright-core";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = createServer((request, response) => {
  const pathname = new URL(request.url, "http://local").pathname;
  const path = pathname === "/" ? "index.html" : pathname;
  try {
    const body = readFileSync(join(dist, path));
    response.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ channel: process.env.BROWSER ?? "msedge", args: ["--autoplay-policy=no-user-gesture-required"] });

/** Runs in the page before the app: fake screen sharing, save dialog and a record of worker output. */
function fakes(options) {
  if (location.protocol !== "http:") return;
  localStorage.setItem("screensway.language", options.language ?? "en");
  window.__test = { tracks: [], samples: null };
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 800;
    const context = canvas.getContext("2d");
    const started = performance.now();
    const stops = [[200, 150], [900, 300], [400, 600], [1000, 650], [600, 200], [300, 500]];
    const draw = () => {
      const t = performance.now() - started;
      // A window resized mid-recording.
      if (options.resizeAtMs && t > options.resizeAtMs && canvas.width === 1280) canvas.width = 960;
      const { width, height } = canvas;
      context.fillStyle = "#1d2230";
      context.fillRect(0, 0, width, height);
      context.fillStyle = "#e8eaf2";
      for (let row = 0; row < 8; row++) context.fillRect(60, 60 + row * 80, width * 0.4, 18);
      // The pointer moves for 0.6 s, then rests for 1.4 s at each stop.
      const leg = Math.floor(t / 2_000) % (stops.length - 1);
      const k = Math.min(1, (t % 2_000) / 600);
      // Whole pixels, like a real pointer, so its edges look the same wherever it is.
      const x = Math.round(((stops[leg][0] + (stops[leg + 1][0] - stops[leg][0]) * k) * width) / 1280) + 0.5;
      const y = Math.round(stops[leg][1] + (stops[leg + 1][1] - stops[leg][1]) * k) + 0.5;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x, y + 22);
      context.lineTo(x + 6, y + 17);
      context.lineTo(x + 11, y + 26);
      context.lineTo(x + 15, y + 24);
      context.lineTo(x + 10, y + 15);
      context.lineTo(x + 17, y + 15);
      context.closePath();
      context.fillStyle = "#000";
      context.strokeStyle = "#fff";
      context.lineWidth = 2;
      context.fill();
      context.stroke();
      requestAnimationFrame(draw);
    };
    draw();
    const stream = canvas.captureStream(30);
    const audio = new AudioContext();
    const tone = audio.createOscillator();
    const destination = audio.createMediaStreamDestination();
    tone.connect(destination);
    tone.start();
    stream.addTrack(destination.stream.getAudioTracks()[0]);
    window.__test.tracks.push(...stream.getTracks());
    // Stop sharing from the browser's bar while the app is still starting.
    if (options.endImmediately) setTimeout(() => stream.getVideoTracks()[0].dispatchEvent(new Event("ended")), 0);
    return stream;
  };
  if (options.failWritesAfter !== undefined) {
    // A disk that fills up while recording (only the recording folder's writes fail).
    const write = FileSystemWritableFileStream.prototype.write;
    let writes = 0;
    FileSystemWritableFileStream.prototype.write = function (data) {
      if (data instanceof Blob && ++writes > options.failWritesAfter) return Promise.reject(new DOMException("Quota exceeded", "QuotaExceededError"));
      return write.call(this, data);
    };
  }
  if (options.failRecordingClose) {
    // The disk fills up just as the recording's file is committed.
    FileSystemWritableFileStream.prototype.close = () => Promise.reject(new DOMException("Quota exceeded", "QuotaExceededError"));
  }
  if (options.failRecorder) {
    window.MediaRecorder = class extends MediaRecorder {
      constructor() {
        throw new Error("encoder unavailable");
      }
    };
  }
  // A save dialog that returns a file like one outside the browser: the page cannot delete
  // it, and the test can slow its writes to hold an export in its last step.
  window.showSaveFilePicker = async () => {
    const real = await (await navigator.storage.getDirectory()).getFileHandle("export-test.mp4", { create: true });
    return {
      kind: "file",
      name: real.name,
      getFile: () => real.getFile(),
      createWritable: async (writeOptions) => {
        if (window.__test.failOpen) throw new DOMException("The request is not allowed by the user agent", "NotAllowedError");
        const writable = await real.createWritable(writeOptions);
        let writes = 0;
        return {
          write: async (chunk) => {
            if (window.__test.slowWrites) await new Promise((resolve) => setTimeout(resolve, 300));
            // The disk fills up or permission is withdrawn while the file is written (mediabunny
            // writes 16 MB at a time, so a short test export makes a single write).
            window.__test.writes = ++writes;
            if (writes === window.__test.failWriteAt) throw new DOMException("Quota exceeded", "QuotaExceededError");
            return writable.write(chunk);
          },
          close: async () => {
            window.__test.closing = true;
            window.__test.closes = (window.__test.closes ?? 0) + 1;
            if (window.__test.slowClose) await new Promise((resolve) => setTimeout(resolve, 1_500));
            if (window.__test.failClose) throw new DOMException("Commit failed", "InvalidStateError");
            return writable.close();
          },
          abort: (reason) => writable.abort(reason),
        };
      },
    };
  };
  const createImageBitmap = window.createImageBitmap;
  window.createImageBitmap = (...args) => (window.__test.failExport ? Promise.reject(new Error("export broke")) : createImageBitmap(...args));
  const Original = window.Worker;
  window.Worker = class extends Original {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", (event) => {
        if (event.data?.type === "samples") {
          window.__test.samples = event.data.samples;
          window.__test.analysedFrames = event.data.motion.length;
        }
      });
    }
  };
}

// Every page runs under the production Content-Security-Policy; any violation fails the run.
const cspViolations = [];

async function openApp(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => console.error("page error:", error.message));
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) cspViolations.push(message.text().slice(0, 200));
  });
  await page.addInitScript(fakes, options);
  await page.goto(base);
  return page;
}

/** Puts recognisable content in the file the save dialog returns, as if it already existed. */
const seed = (page) =>
  page.evaluate(async () => {
    const writable = await (await (await navigator.storage.getDirectory()).getFileHandle("export-test.mp4", { create: true })).createWritable();
    await writable.write("ORIGINAL VIDEO");
    await writable.close();
  });

const chosenFile = (page) =>
  page.evaluate(async () => {
    try {
      return await (await (await (await navigator.storage.getDirectory()).getFileHandle("export-test.mp4")).getFile()).text();
    } catch {
      return null;
    }
  });

/** The chosen file's MP4, read back and described with mediabunny. */
async function readExport(page) {
  const base64 = await page.evaluate(async () => {
    const file = await (await (await navigator.storage.getDirectory()).getFileHandle("export-test.mp4")).getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  });
  const input = new Input({ source: new BufferSource(Buffer.from(base64, "base64")), formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    return {
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      codec: video?.codec,
      duration: await input.computeDuration(),
      videoDuration: video ? await video.computeDuration() : 0,
      audioDuration: audio ? await audio.computeDuration() : 0,
    };
  } finally {
    input.dispose();
  }
}

const storedRecordings = (page) =>
  page.evaluate(async () => {
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle("recordings", { create: true });
    const names = [];
    // Chromium keeps writes in a ".crswap" file until they are closed.
    for await (const [name] of folder.entries()) if (!name.endsWith(".crswap")) names.push(name);
    return names;
  });

async function record(page, ms) {
  await page.getByRole("button", { name: "Start recording" }).click();
  await page.getByRole("button", { name: "Stop recording" }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(ms);
}

try {
  // 1. Record with sound, resize the shared window (frames keep the first size, with bars),
  //    stop from the browser's own controls, export to a file and leave without being asked.
  {
    const page = await openApp({ resizeAtMs: Number(process.env.RESIZE_AT ?? 3_500) });
    await record(page, 7_000);
    assert.equal((await storedRecordings(page)).length, 1, "the recording is written to disk while recording");
    await page.evaluate(() => window.__test.tracks.find((track) => track.kind === "video").dispatchEvent(new Event("ended")));
    await page.locator(".preview-section").waitFor({ timeout: 30_000 });
    if (process.env.SAVE_RECORDING) {
      const recorded = await page.evaluate(async () => {
        const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle("recordings");
        for await (const [name, entry] of folder.entries()) {
          if (name.endsWith(".crswap")) continue;
          const bytes = new Uint8Array(await (await entry.getFile()).arrayBuffer());
          let text = "";
          for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(text);
        }
      });
      (await import("node:fs")).writeFileSync(process.env.SAVE_RECORDING, Buffer.from(recorded, "base64"));
    }
    const heading = await page.locator(".preview-section .web-studio-heading p").textContent();
    assert.match(heading, /[1-9]\d* zooms? where your pointer paused/, heading);
    const samples = await page.evaluate(() => window.__test.samples);
    assert.ok(samples.length > 50, `pointer followed (${samples.length} samples)`);
    assert.ok(samples.every((s) => s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1), "positions are fractions of the frame");
    const analysed = await page.evaluate(() => window.__test.analysedFrames);
    assert.ok(analysed >= 7 * 30 * 0.8, `the worker keeps up with 30 fps (${analysed} frames in 7 s)`);
    await seed(page);

    await page.getByRole("button", { name: "Export video" }).click();
    await page.locator(".export-done, .export-box .capture-message.error").first().waitFor({ timeout: 120_000 });
    assert.equal(await page.locator(".export-box .capture-message.error").count(), 0, await page.locator(".export-box").textContent());
    assert.equal(await page.getByRole("button", { name: "Download again" }).count(), 0, "a saved file is not offered again");
    const exported = await readExport(page);
    assert.ok(exported.hasVideo && exported.hasAudio, "the MP4 has video and sound");
    assert.equal(exported.codec, "avc");
    assert.ok(exported.duration > 6 && exported.duration < 8.5, `export lasts as long as the recording (${exported.duration.toFixed(2)} s)`);
    assert.ok(Math.abs(exported.audioDuration - exported.videoDuration) < 0.2, "sound and picture end together");

    let asked = 0;
    page.on("dialog", (dialog) => {
      asked++;
      void dialog.accept();
    });
    await page.goto("about:blank");
    assert.equal(asked, 0, "leaving after an export does not warn");
    await page.close();
    console.log("record, resize, stop sharing, export: ok");
  }

  // 2. Cancel a large export mid-way and while its file is being completed, and make one
  //    fail: the file the user chose keeps its old content every time. Then close the
  //    recording: its stored file is deleted.
  {
    const page = await openApp();
    await record(page, 6_000);
    await page.getByRole("button", { name: "Stop recording" }).click();
    await page.locator(".preview-section").waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "4K", exact: true }).click();
    await seed(page);
    const cancelAt = async (percent) => {
      await page.getByRole("button", { name: "Export video" }).click();
      // Clicked from the page as soon as the progress reaches it, before the export can finish.
      await page.evaluate((target) => new Promise((resolve, reject) => {
        const giveUp = setTimeout(() => reject(new Error(`export never reached ${target}%: ${document.querySelector(".export-box")?.textContent}`)), 90_000);
        const check = () => {
          const shown = Number(document.querySelector(".export-progress")?.getAttribute("aria-valuenow") ?? -1);
          if (shown >= target) {
            // At 99% the file is being completed: slow its writes so the cancel lands during that step.
            if (target >= 99) window.__test.slowWrites = true;
            [...document.querySelectorAll(".export-box button")].find((button) => button.textContent.includes("Cancel"))?.click();
            clearTimeout(giveUp);
            resolve();
          } else requestAnimationFrame(check);
        };
        check();
      }), percent);
      await page.getByRole("button", { name: "Export video" }).waitFor({ timeout: 60_000 });
      await page.evaluate(() => (window.__test.slowWrites = false));
      assert.equal(await page.locator(".export-done").count(), 0, `an export cancelled at ${percent}% is not reported as saved`);
      assert.equal(await chosenFile(page), "ORIGINAL VIDEO", `an export cancelled at ${percent}% leaves the chosen file as it was`);
    };
    await cancelAt(60);
    await cancelAt(99);

    // Failures before writing, after part of the file was written, and when committing it.
    for (const [failure, what] of [["failExport", "before writing"], ["failWriteAt", "while writing it"], ["failClose", "while committing it"]]) {
      await page.evaluate((key) => (window.__test[key] = key === "failWriteAt" ? 1 : true), failure);
      await page.getByRole("button", { name: "Export video" }).click();
      await page.getByText("Export failed").waitFor({ timeout: 60_000 }).catch(async (error) => {
        throw new Error(`${what}: ${await page.locator(".export-box").textContent()} (writes: ${await page.evaluate(() => window.__test.writes)})`, { cause: error });
      });
      assert.equal(await chosenFile(page), "ORIGINAL VIDEO", `an export failing ${what} leaves the chosen file as it was`);
      if (failure !== "failExport") assert.match(await page.locator(".export-box").textContent(), /could not be written to the file/, `a failure ${what} is explained in the page's language`);
      await page.evaluate((key) => (window.__test[key] = undefined), failure);
    }

    // Once the file is being committed, Cancel is gone and the export completes.
    await page.evaluate(() => {
      window.__test.slowClose = true;
      window.__test.closing = false;
    });
    await page.getByRole("button", { name: "Export video" }).click();
    await page.waitForFunction(() => window.__test.closing, null, { timeout: 90_000 });
    assert.equal(await page.locator(".export-box").getByRole("button", { name: "Cancel" }).count(), 0, "Cancel is not offered while committing");
    await page.locator(".export-done").waitFor({ timeout: 30_000 });
    assert.notEqual(await chosenFile(page), "ORIGINAL VIDEO", "a committed export replaces the chosen file");
    await page.evaluate(() => (window.__test.slowClose = false));
    assert.equal(await page.evaluate(async () => {
      const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports", { create: true });
      let count = 0;
      for await (const _ of folder.entries()) count++;
      return count;
    }), 0, "no temporary export is left");

    await page.getByRole("button", { name: "Close preview" }).click();
    await page.waitForTimeout(300);
    assert.deepEqual(await storedRecordings(page), [], "closing a recording deletes its stored file");
    page.on("dialog", (dialog) => void dialog.dismiss());
    await page.close({ runBeforeUnload: false });
    console.log("cancel, failures and commit point keep the chosen file safe: ok");
  }

  // 4. Stopping sharing while the app is still starting cancels the start.
  {
    const page = await openApp({ endImmediately: true });
    await page.getByRole("button", { name: "Start recording" }).click();
    await page.getByText("Nothing was shared").waitFor({ timeout: 15_000 });
    const states = await page.evaluate(() => window.__test.tracks.map((track) => track.readyState));
    assert.ok(states.every((state) => state === "ended"), `capture stopped (${states})`);
    assert.deepEqual(await storedRecordings(page), [], "no recording file is kept");
    await page.close();
    console.log("stop sharing while starting: ok");
  }

  // 5. A disk that fills up stops the recording and says so, instead of a cut-short recording.
  {
    const page = await openApp({ failWritesAfter: 2 });
    await page.getByRole("button", { name: "Start recording" }).click();
    await page.getByText(/not enough free disk space/).waitFor({ timeout: 20_000 });
    assert.equal(await page.locator(".preview-section").count(), 0, "no studio for an incomplete recording");
    assert.deepEqual(await storedRecordings(page), [], "the incomplete file is deleted");
    await page.close();
    console.log("disk full while recording: ok");
  }

  // 6. A disk that fills up as the recording is committed is reported the same way.
  {
    const page = await openApp({ failRecordingClose: true });
    await record(page, 2_000);
    await page.getByRole("button", { name: "Stop recording" }).click();
    await page.getByText(/not enough free disk space/).waitFor({ timeout: 20_000 });
    assert.equal(await page.locator(".preview-section").count(), 0, "no studio for an uncommitted recording");
    await page.close();
    console.log("disk full while committing the recording: ok");
  }

  // 7. A very short recording, trimmed close to both ends, exports exactly the kept part.
  {
    const page = await openApp();
    await record(page, 1_200);
    await page.getByRole("button", { name: "Stop recording" }).click();
    await page.locator(".preview-section").waitFor({ timeout: 30_000 });
    for (const [handle, key] of [["Start of the video", "ArrowRight"], ["End of the video", "ArrowLeft"]]) {
      await page.getByRole("slider", { name: handle }).or(page.getByLabel(handle)).first().focus();
      await page.keyboard.press(key);
      await page.keyboard.press(key);
    }
    const kept = await page.locator(".timeline-title").textContent();
    const keptSeconds = Number(kept.match(/\((\d+):(\d+(?:\.\d+)?)\)/).slice(1).reduce((minutes, seconds) => minutes * 60 + Number(seconds), 0));
    assert.match(kept, /Keeping 0:00\.2/, `trimmed at the start (${kept})`);
    await page.getByRole("button", { name: "Export video" }).click();
    await page.locator(".export-done").waitFor({ timeout: 60_000 });
    const exported = await readExport(page);
    assert.ok(Math.abs(exported.duration - keptSeconds) < 0.1, `export is the kept ${keptSeconds} s (${exported.duration.toFixed(3)} s)`);
    assert.ok(Math.abs(exported.audioDuration - exported.videoDuration) < 0.1, "sound and picture end together");
    page.on("dialog", (dialog) => void dialog.dismiss());
    await page.close({ runBeforeUnload: false });
    console.log("short recording trimmed at both ends: ok");
  }

  // 8. In Vietnamese, a file that refuses to open is explained in Vietnamese, not in the
  //    browser's technical English, and the chosen file is untouched.
  {
    const page = await openApp({ language: "vi" });
    await page.getByRole("button", { name: "Bắt đầu quay" }).click();
    await page.getByRole("button", { name: "Dừng quay" }).waitFor({ timeout: 15_000 });
    await page.waitForTimeout(2_000);
    await page.getByRole("button", { name: "Dừng quay" }).click();
    await page.locator(".preview-section").waitFor({ timeout: 30_000 });
    await seed(page);
    await page.evaluate(() => (window.__test.failOpen = true));
    await page.getByRole("button", { name: "Xuất video" }).click();
    await page.getByText("Xuất thất bại").waitFor({ timeout: 30_000 });
    const message = await page.locator(".export-box").textContent();
    assert.match(message, /Không ghi được video vào file/, message);
    assert.doesNotMatch(message, /not allowed/i, "no technical browser wording");
    assert.equal(await chosenFile(page), "ORIGINAL VIDEO", "the chosen file is untouched");
    page.on("dialog", (dialog) => void dialog.dismiss());
    await page.close({ runBeforeUnload: false });
    console.log("Vietnamese export error when the file cannot be opened: ok");
  }

  // 3. A recorder that fails to start must not keep the screen shared.
  {
    const page = await openApp({ failRecorder: true });
    await page.getByRole("button", { name: "Start recording" }).click();
    await page.locator(".capture-message.error").waitFor({ timeout: 15_000 });
    const states = await page.evaluate(() => window.__test.tracks.map((track) => track.readyState));
    assert.ok(states.length > 0 && states.every((state) => state === "ended"), `capture stopped (${states})`);
    assert.equal(await page.getByRole("button", { name: "Start recording" }).isEnabled(), true);
    await page.close();
    console.log("failed start releases the screen: ok");
  }
  const built = readFileSync(join(dist, "index.html"), "utf8");
  assert.match(built, /<meta http-equiv="Content-Security-Policy"[^>]*connect-src[^>]*>/, "the build carries a CSP");
  assert.deepEqual(cspViolations, [], "nothing was blocked by the CSP");
  console.log("no Content-Security-Policy violations: ok");
  console.log("studio-web e2e: ok");
} finally {
  await browser.close();
  server.close();
}
