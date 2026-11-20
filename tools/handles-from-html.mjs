#!/usr/bin/env node
// Prints a comma-separated list of YouTube channels found in saved YouTube HTML, ready to paste into
// FilterTube (Sources -> Add channels). Runs locally; reads files or stdin; needs only Node.js.
//
//   node tools/handles-from-html.mjs subscriptions.html
//   pbpaste | node tools/handles-from-html.mjs            (macOS clipboard)
//
// How to get the HTML: on youtube.com open the left sidebar, click "Show more" under Subscriptions,
// right-click a channel -> Inspect, select the <div id="items"> element that holds the list ->
// right-click -> Copy -> Copy outerHTML, and save it to a file (or pipe the clipboard as above).
import fs from "node:fs";

const files = process.argv.slice(2);
const html = files.length ? files.map((f) => fs.readFileSync(f, "utf8")).join("\n") : fs.readFileSync(0, "utf8");

const seen = new Set();
const out = [];
// Channel links look like href="/@handle" or href="/channel/UC…" (optionally with the full youtube.com URL).
const re = /href="(?:https?:\/\/(?:www\.)?youtube\.com)?\/(@[\w.-]+|channel\/UC[\w-]{22})\/?"/g;
for (const m of html.matchAll(re)) {
  const ch = m[1].startsWith("@") ? m[1] : m[1].slice("channel/".length);
  if (!seen.has(ch.toLowerCase())) { seen.add(ch.toLowerCase()); out.push(ch); }
}

if (!out.length) {
  console.error("No channel links found. Copy the sidebar's <div id=\"items\"> element (see the comment at the top).");
  process.exit(1);
}
console.log(out.join(", "));
console.error(`${out.length} channels`);
