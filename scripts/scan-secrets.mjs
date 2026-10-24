// One-shot secrets scanner for tracked files (deletes itself after use is fine).
import { execSync } from "node:child_process";

const tracked = execSync("git ls-files", { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const patterns = [
  /sk-[a-zA-Z0-9]{20,}/,
  /gho_[a-zA-Z0-9]{20,}/,
  /api[_-]?key\s*[:=]\s*["'][a-zA-Z0-9]{16,}["']/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /Bearer [a-zA-Z0-9_\-]{25,}/,
];

const fs = await import("node:fs");
let hits = 0;
for (const f of tracked) {
  let content;
  try {
    content = fs.readFileSync(f, "utf8");
  } catch {
    continue;
  }
  for (const re of patterns) {
    const m = content.match(re);
    if (m) {
      // allow obvious placeholders/docs
      if (/your[-_]?api[-_]?key|sk-xxx|sk-\.\.\./i.test(m[0])) continue;
      hits++;
      console.log(`SUSPECT ${f}: ${m[0].slice(0, 40)}…`);
    }
  }
}
console.log(hits === 0 ? `SECRETS SCAN CLEAN (${tracked.length} tracked files)` : `FOUND ${hits} suspect match(es)`);
process.exit(hits === 0 ? 0 : 1);
