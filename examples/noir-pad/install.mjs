/**
 * NoirPad installer — copies the web app into a NOIR project so `noir serve`
 * hosts it at /apps/noirpad/.
 *
 * Usage:
 *   node examples/noir-pad/install.mjs [projectDir]   (default: current dir)
 */
import { cpSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "www");
const projectDir = resolve(process.argv[2] ?? process.cwd());
const dest = join(projectDir, ".noir", "webapps", "noirpad");

if (!existsSync(src)) {
  console.error("install failed: examples/noir-pad/www not found (run from the noir repo)");
  process.exit(1);
}
if (!existsSync(projectDir)) {
  console.error(`install failed: project directory not found: ${projectDir}`);
  process.exit(1);
}

mkdirSync(join(dest, "data"), { recursive: true });
cpSync(src, dest, { recursive: true });
writeFileSync(
  join(dest, "data", "index.json"),
  JSON.stringify({ notes: [] }, null, 2),
  "utf8"
);

console.log(`NoirPad installed into ${dest}`);
console.log(`Start NOIR, then open:  http://127.0.0.1:5178/apps/noirpad/`);
console.log(`(from the mobile app: APPS tab -> NoirPad -> OPEN)`);
