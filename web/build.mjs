// Bundles src/main.js into dist/ and copies index.html. `--serve` serves dist/ on :8080.
import * as esbuild from "esbuild";
import fs from "node:fs";

fs.mkdirSync("dist", { recursive: true });
fs.copyFileSync("index.html", "dist/index.html");
const opts = { entryPoints: ["src/main.js"], bundle: true, format: "esm", target: "es2020", minify: true, sourcemap: false, outfile: "dist/app.js" };
if (process.argv.includes("--serve")) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: "dist", port: 8080 });
  console.log(`Serving on http://localhost:${port}`);
} else {
  await esbuild.build(opts);
  console.log("Built dist/");
}
