// Runs the on-device text-matching model off the main thread.
// Model files and the ONNX runtime are served from this site (models/ and ort/), so nothing goes to third parties.
import { pipeline, env } from "@huggingface/transformers";

env.allowRemoteModels = false;
env.allowLocalModels = true;
// Must be a relative path: with a full URL, transformers.js (4.3.2) skips local files when checking
// whether tokenizer files exist, and then never loads the tokenizer.
env.localModelPath = "./models/";
env.backends.onnx.wasm.wasmPaths = new URL("./ort/", self.location.href).href;
env.backends.onnx.wasm.numThreads = 1; // GitHub Pages can't send the headers multithreading needs

const MODEL = "Xenova/all-MiniLM-L6-v2";
let extractor = null;

async function getExtractor() {
  if (!extractor) {
    extractor = await pipeline("feature-extraction", MODEL, {
      dtype: "q8",
      device: "wasm",
      progress_callback: (p) => { if (p.status === "progress" && String(p.file || "").endsWith(".onnx")) self.postMessage({ type: "progress", loaded: p.loaded, total: p.total }); },
    });
  }
  return extractor;
}

self.onmessage = async (e) => {
  const { id, texts } = e.data;
  try {
    const ex = await getExtractor();
    const out = [];
    for (let i = 0; i < texts.length; i += 32) {
      const t = await ex(texts.slice(i, i + 32), { pooling: "mean", normalize: true });
      const d = t.dims[1];
      for (let j = 0; j < t.dims[0]; j++) out.push(Array.from(t.data.subarray(j * d, (j + 1) * d)));
    }
    self.postMessage({ id, vectors: out });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err), stack: String(err?.stack || "").slice(0, 800) });
  }
};
