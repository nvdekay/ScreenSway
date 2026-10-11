// Set EN/VI fixture paths explicitly: no network request occurs in this test or the app.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
if (process.platform !== "win32") process.exit(0);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const triple = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
const helper = path.join(root, "apps/desktop/src-tauri/binaries", `screensway-capture-${triple}.exe`);
const work = mkdtempSync(path.join(tmpdir(), "screensway-speech-test-"));
const measurements = [];
for (const [locale, key, anchors] of [
  ["en-US", "SCREENSWAY_TEST_EN_AUDIO", ["recording", "captions", "computer"]],
  ["vi-VN", "SCREENSWAY_TEST_VI_AUDIO", ["động vật", "quan sát"]],
]) {
  const audio = process.env[key]; assert(audio, `Set ${key} to a local speech fixture.`);
  const output = path.join(work, `${locale}.json`);
  const started = Date.now();
  const child = spawnSync(helper, ["--transcribe", audio, "--locale", locale, "--output", output], { encoding: "utf8", timeout: 300_000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  writeFileSync(path.join(work, `${locale}.log`), child.stderr);
  const result = JSON.parse(child.stdout); assert.deepEqual(result, JSON.parse(readFileSync(output, "utf8")));
  assert.equal(result.locale, locale); assert(result.words.length > 5);
  assert(result.words.every((w, i) => w.text.trim() && !w.text.includes("\ufffd") && w.startMs >= 0 && w.endMs > w.startMs && (i === 0 || w.startMs >= result.words[i - 1].startMs)));
  const text = result.words.map(w => w.text).join(" ").toLowerCase();
  const seconds = (Date.now() - started) / 1000;
  const measurement = { locale, seconds, words: result.words.length, text };
  if (process.env.SCREENSWAY_TEST_MAX_SPEECH_SECONDS) {
    const limit = Number(process.env.SCREENSWAY_TEST_MAX_SPEECH_SECONDS);
    assert(Number.isFinite(limit) && limit > 0, "Speech time limit must be a positive number.");
    assert(seconds <= limit, `${locale} took ${seconds.toFixed(1)} s, exceeding the configured ${limit} s budget.`);
  }
  for (const anchor of anchors) assert(text.includes(anchor), `${locale} did not recognize '${anchor}': ${text}`);
  if (locale === "vi-VN") {
    const reference = "Một số loài động vật như voi và hươu cao cổ thường hay lại gần xe và chỉ với các dụng cụ bình thường chúng ta cũng sẽ quan sát một cách dễ dàng";
    const normalize = t => t.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim().split(/\s+/);
    const expected = normalize(reference), actual = normalize(text);
    let row = Array.from({ length: actual.length + 1 }, (_, i) => i);
    expected.forEach((word, i) => {
      const next = [i + 1];
      actual.forEach((candidate, j) => next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (word === candidate ? 0 : 1))));
      row = next;
    });
    const wer = row[actual.length] / expected.length;
    measurement.wer = wer;
    assert(wer <= 0.2, `Vietnamese fixture word error rate exceeds 20%: ${(wer*100).toFixed(1)}%`);
    console.log(`  Vietnamese fixture WER: ${(wer*100).toFixed(1)}% (${row[actual.length]}/${expected.length})`);
  }
  assert(child.stderr.includes("SCREENSWAY_PROGRESS 100"));
  measurements.push(measurement);
  console.log(`${locale}: ${result.words.length} timed words, ${seconds.toFixed(1)} s; ${text}`);
}
writeFileSync(path.join(work, "measurements.json"), JSON.stringify(measurements, null, 2));
console.log(`Windows offline speech checks passed. Artifacts: ${work}`);
