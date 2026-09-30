#!/usr/bin/env node
// Generate PNG icons from public/icon.svg.
//
// iOS Safari REQUIRES a PNG apple-touch-icon before it will treat the site
// as an installable PWA (which is a prerequisite for delivering Web Push
// notifications on iOS 16.4+). The SVG icon works for Chrome/Firefox, but
// iPad/iPhone users need real PNGs.
//
// Usage:
//   cd dashboard
//   npm install --no-save sharp     # one-time (~30s)
//   node scripts/generate-icons.mjs
//
// This writes:
//   public/icon-192.png       (192x192, referenced by manifest.webmanifest)
//   public/icon-512.png       (512x512, referenced by manifest.webmanifest)
//   public/apple-touch-icon.png (180x180, required by iOS)
//   public/icon-badge.png     (96x96, used by the push notification badge)

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE   = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(HERE, "..", "public");
const SVG    = join(PUBLIC, "icon.svg");

let sharp;
try {
  sharp = (await import("sharp")).default;
} catch {
  console.error(
    "\n[generate-icons] sharp is not installed.\n" +
    "  cd dashboard && npm install --no-save sharp && node scripts/generate-icons.mjs\n",
  );
  process.exit(1);
}

const svg = await readFile(SVG);

const outputs = [
  { size: 192, name: "icon-192.png" },
  { size: 512, name: "icon-512.png" },
  { size: 180, name: "apple-touch-icon.png" },
  { size: 96,  name: "icon-badge.png" },
];

for (const { size, name } of outputs) {
  const out = join(PUBLIC, name);
  await sharp(svg).resize(size, size).png().toFile(out);
  console.log(`  wrote ${name}  (${size}x${size})`);
}

console.log("\nDone. Commit the PNGs so they ship with the deployed build.");
