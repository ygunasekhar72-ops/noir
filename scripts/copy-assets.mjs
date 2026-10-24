/** Copy non-TS assets into dist: src/web -> dist/web. */
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..", "src", "web");
const dest = resolve(here, "..", "dist", "web");

if (!existsSync(src)) {
  console.error("copy-assets: src/web not found");
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`copy-assets: ${src} -> ${dest}`);
