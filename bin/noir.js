#!/usr/bin/env node
// NOIR — entry shim. Delegates to the compiled CLI in dist/.
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "cli.js");

if (!existsSync(cli)) {
  console.error("noir: dist/cli.js not found — run `npm run build` first.");
  process.exit(1);
}

import(pathToFileURL(cli).href).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
