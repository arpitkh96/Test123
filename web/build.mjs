// Bundles the app and the on-device model worker into dist/, and copies index.html, the model files
// (models/, fetched by `npm run fetch-model`) and the ONNX runtime's WebAssembly (ort/), so the site
// never loads code or models from third parties. `--serve` serves dist/ on :8080.
import * as esbuild from "esbuild";
import fs from "node:fs";

const MODEL = "models/Xenova/all-MiniLM-L6-v2";
if (!fs.existsSync(`${MODEL}/onnx/model_quantized.onnx`)) {
  console.error(`Missing ${MODEL}. Run: npm run fetch-model`);
  process.exit(1);
}
fs.mkdirSync("dist/ort", { recursive: true });
fs.copyFileSync("index.html", "dist/index.html");
fs.cpSync(MODEL, `dist/${MODEL}`, { recursive: true });
// transformers.js loads this ONNX runtime build in browsers without WebGPU
const ortDir = "node_modules/onnxruntime-web/dist";
for (const f of ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"]) fs.copyFileSync(`${ortDir}/${f}`, `dist/ort/${f}`);

const opts = {
  entryPoints: { app: "src/main.js", "embed-worker": "src/embed-worker.js" },
  bundle: true, format: "esm", target: "es2022", minify: true, sourcemap: false, outdir: "dist",
};
if (process.argv.includes("--serve")) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: "dist", port: 8080 });
  console.log(`Serving on http://localhost:${port}`);
} else {
  await esbuild.build(opts);
  console.log("Built dist/");
}
