/** NOIR test runner — executes every test file in sequence, reports pass/fail. */
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertionCountSoFar } from "./helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith(".mjs") && !["run-all.mjs", "helpers.mjs", "mcp-echo-server.mjs"].includes(f))
  .sort();

let passed = 0;
let failed = 0;
const failures = [];
const skipped = [];

for (const f of files) {
  process.stdout.write(`\n\x1b[1m■ ${f}\x1b[0m\n`);
  const t0 = Date.now();
  try {
    const mod = await import(`./${f}`);
    if (typeof mod.test === "function") {
      const r = await mod.test();
      if (r && typeof r === "object" && "skipped" in r) {
        skipped.push({ file: f, reason: r.reason });
        process.stdout.write(`  \x1b[2mSKIP (${r.reason})\x1b[0m\n`);
      } else {
        passed++;
        process.stdout.write(`  \x1b[1mPASS\x1b[0m (${((Date.now() - t0) / 1000).toFixed(1)}s, ${assertionCountSoFar()} assertions so far)\n`);
      }
    } else {
      throw new Error("no exported test() function");
    }
  } catch (err) {
    failed++;
    failures.push({ file: f, err });
    process.stdout.write(`  \x1b[1mFAIL\x1b[0m ${err.message}\n${(err.stack ?? "").split("\n").slice(1, 6).join("\n")}\n`);
  }
}

process.stdout.write(
  `\n${"─".repeat(44)}\n${failed === 0 ? "\x1b[1mALL PASSED\x1b[0m" : "FAILURES"}: ${passed} passed, ${failed} failed, ${skipped.length} skipped, ${assertionCountSoFar()} assertions in ${files.length} files\n`
);
if (failures.length) {
  for (const f of failures) process.stdout.write(`  ${f.file}: ${f.err.message}\n`);
  process.exit(1);
}
process.exit(0);
