// Downloads the on-device topic model (all-MiniLM-L6-v2, 8-bit, about 23 MB) into models/.
import fs from "node:fs";

const REPO = "Xenova/all-MiniLM-L6-v2";
const FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx"];
for (const f of FILES) {
  const dest = `models/${REPO}/${f}`;
  if (fs.existsSync(dest)) continue;
  fs.mkdirSync(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
  const res = await fetch(`https://huggingface.co/${REPO}/resolve/main/${f}`);
  if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log("fetched", f);
}
