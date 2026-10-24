#!/usr/bin/env node
// NOIR — entry shim. Delegates to the compiled CLI in dist/.
// NOTE: calls main() EXPLICITLY — when invoked through the global `noir`
// symlink (npm link / npm i -g), argv[1] has no .js extension, so filename
// heuristics inside cli.ts must never be load-bearing.
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "cli.js");

if (!existsSync(cli)) {
  console.error("noir: dist/cli.js not found — run `npm run build` first.");
  process.exit(1);
}

import(pathToFileURL(cli).href)
  .then((m) => {
    if (typeof m.main !== "function") {
      console.error("noir: dist/cli.js does not export main() — rebuild with `npm run build`.");
      process.exit(1);
    }
    return m.main(process.argv.slice(2));
  })
  .then(
    (code) => process.exit(typeof code === "number" ? code : 0),
    (err) => {
      console.error(err && err.stack ? err.stack : String(err));
      process.exit(1);
    }
  );
