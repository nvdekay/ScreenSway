// Explicit build-time download only. The installed app never downloads speech models.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const modelSha256 = "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2";
export const modelPath = fileURLToPath(new URL("../apps/desktop/src-tauri/resources/models/ggml-large-v3-turbo-q5_0.bin", import.meta.url));
export async function verifyModel() {
  if (!existsSync(modelPath)) return false;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(modelPath)) hash.update(chunk);
  return hash.digest("hex") === modelSha256;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (await verifyModel()) {
    console.log("Windows offline speech model verified.");
  } else {
    await mkdir(path.dirname(modelPath), { recursive: true });
    const temporary = `${modelPath}.download`;
    try {
      console.log("Downloading multilingual Whisper large-v3-turbo Q5 model (574 MB) for offline EN/VI captions...");
      const response = await fetch("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin", { signal: AbortSignal.timeout(600_000) });
      if (!response.ok || !response.body) throw new Error(`Speech model download failed: HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(temporary)) hash.update(chunk);
      if (hash.digest("hex") !== modelSha256) throw new Error("Speech model checksum does not match the pinned release.");
      await rename(temporary, modelPath);
      console.log("Windows offline speech model downloaded and verified.");
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
