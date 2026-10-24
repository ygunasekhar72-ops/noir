import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve, dirname, relative, sep, isAbsolute } from "node:path";
import { mkdirSync } from "node:fs";
import { errResult, schema, textResult, type Tool } from "./types.js";

/** resolve against tool cwd + project dir; rejects missing/invalid paths outright */
function resolvePath(cwd: string, p: unknown): string {
  if (typeof p !== "string" || p.trim() === "") throw new Error("path is required (non-empty string)");
  return resolve(cwd, p);
}

/**
 * Project boundary guard: file tools never touch anything outside the project
 * directory. Defense-in-depth for the mobile app server (the AI cannot be
 * social-engineered into reading/writing files outside the workspace).
 * Shell access remains possible via run_command — by design, like a terminal.
 */
function assertInsideProject(cwd: string, resolved: string): void {
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `path escapes the project directory (${resolved}). File tools are locked to the project root — use run_command if you truly need a file outside it.`
    );
  }
}

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", ".noir", "__pycache__", ".cache"]);

function walk(dir: string, opts: { includeHidden: boolean; maxEntries: number; out: string[] }): void {
  if (opts.out.length >= opts.maxEntries) return;
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (opts.out.length >= opts.maxEntries) return;
    if (!opts.includeHidden && e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      walk(full, opts);
    } else if (e.isFile()) {
      opts.out.push(full);
    }
  }
}

/** glob -> RegExp (supports **, *, ?, {a,b}; each alternative is fully converted) */
export function globToRegExp(glob: string): RegExp {
  const braceMatch = glob.match(/\{([^{}]+)\}/);
  if (braceMatch && braceMatch.index !== undefined) {
    const pre = glob.slice(0, braceMatch.index);
    const post = glob.slice(braceMatch.index + braceMatch[0].length);
    const alts = braceMatch[1]
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a.length > 0)
      .map((a) => globToRegExp(pre + a + post).source);
    if (alts.length > 1) return new RegExp(`(?:${alts.join("|")})`, "i");
  }
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (glob[i] === "/") i++; // **/ -> .*
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp("^" + re + "$", "i");
}

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tar", ".rar", ".7z",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".apk", ".jar", ".class", ".wasm", ".mp3", ".mp4",
  ".mov", ".avi", ".mkv", ".ogg", ".wav", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".db", ".sqlite",
]);

export function looksBinary(path: string, buffer: string): boolean {
  if (BINARY_EXT.has(path.slice(path.lastIndexOf(".")).toLowerCase())) return true;
  return buffer.slice(0, 1024).includes("\0");
}

export const fsTools: Tool[] = [
  {
    name: "read_file",
    description:
      "Read a text file. Returns numbered lines. Use offset/limit (1-based lines) for paging through large files. Binary files are rejected.",
    parameters: schema.obj({
      path: schema.str("File path, relative to the project directory"),
      offset: schema.num("Line number to start reading from (1-based, optional)"),
      limit: schema.num("Max number of lines to read (default 2000)"),
    }, ["path"]),
    readOnly: true,
    run(args, ctx) {
      const path = resolvePath(ctx.cwd, args.path);
      assertInsideProject(ctx.cwd, path);
      if (!existsSync(path) || !statSync(path).isFile()) return errResult(`File not found: ${path}`);
      const raw = readFileSync(path, "utf8");
      if (looksBinary(path, raw)) return errResult(`Refusing to read binary file: ${path}`);
      const limit = Math.min(Number(args.limit ?? 2000), 5000);
      const offset = Math.max(Number(args.offset ?? 1), 1);
      const normalized = raw.replace(/\r\n/g, "\n");
      const body = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
      const allLines = body === "" ? [] : body.split("\n");
      const MAX_LINE = 2000;
      const startIdx = offset - 1;
      const slice = allLines.slice(startIdx, startIdx + limit).map((l) =>
        l.length > MAX_LINE ? l.slice(0, MAX_LINE) + `…(line truncated, ${l.length} chars total)` : l
      );
      const width = String(startIdx + slice.length).length;
      const numbered = slice.map((l, i) => `${String(startIdx + i + 1).padStart(width)}| ${l}`).join("\n");
      const total = allLines.length;
      const shown = `${numbered}${numbered ? "\n" : ""}${total > startIdx + slice.length ? `… (${total - startIdx - slice.length} more lines, total ${total})` : `(${total} lines total)`}`;
      return textResult(shown);
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the given content. Parent directories are created automatically.",
    parameters: schema.obj({
      path: schema.str("File path, relative to the project directory"),
      content: schema.str("Full file content to write"),
    }, ["path", "content"]),
    run(args, ctx) {
      const path = resolvePath(ctx.cwd, args.path);
      assertInsideProject(ctx.cwd, path);
      mkdirSync(dirname(path), { recursive: true });
      const content = String(args.content ?? "");
      writeFileSync(path, content, "utf8");
      return textResult(`Wrote ${content.length} bytes (${content.split(/\r?\n/).length} lines) to ${path}`);
    },
  },
  {
    name: "edit_file",
    description:
      "Edit a file by exact string replacement. oldString must match the file exactly (including whitespace) and be unique unless replaceAll=true.",
    parameters: schema.obj({
      path: schema.str("File path"),
      oldString: schema.str("Exact text to find"),
      newString: schema.str("Replacement text"),
      replaceAll: schema.bool("Replace every occurrence (default false)"),
    }, ["path", "oldString", "newString"]),
    run(args, ctx) {
      const path = resolvePath(ctx.cwd, args.path);
      assertInsideProject(ctx.cwd, path);
      if (!existsSync(path)) return errResult(`File not found: ${path}`);
      const raw = readFileSync(path, "utf8");
      const oldStr = String(args.oldString ?? "");
      const newStr = String(args.newString ?? "");
      if (oldStr === "") return errResult("oldString must not be empty");
      const count = raw.split(oldStr).length - 1;
      if (count === 0) return errResult(`oldString not found in ${path}`);
      if (count > 1 && args.replaceAll !== true) {
        return errResult(`oldString occurs ${count} times in ${path}. Add more surrounding context to make it unique, or set replaceAll=true.`);
      }
      const updated = args.replaceAll === true ? raw.split(oldStr).join(newStr) : raw.replace(oldStr, newStr);
      writeFileSync(path, updated, "utf8");
      return textResult(`OK — replaced ${args.replaceAll === true ? count : 1} occurrence(s) in ${path}`);
    },
  },
  {
    name: "list_files",
    description: "List files matching a glob pattern (e.g. \"**/*.ts\", \"src/**/*.tsx\"). Returns paths with line counts where cheap.",
    parameters: schema.obj({
      pattern: schema.str("Glob pattern"),
      path: schema.str("Base directory (default: project root)"),
    }, ["pattern"]),
    readOnly: true,
    run(args, ctx) {
      const base = args.path ? resolvePath(ctx.cwd, args.path) : ctx.cwd;
      assertInsideProject(ctx.cwd, base);
      if (!existsSync(base)) return errResult(`Directory not found: ${base}`);
      const files: string[] = [];
      walk(base, { includeHidden: false, maxEntries: 4000, out: files });
      const re = globToRegExp(String(args.pattern));
      const matches = files
        .map((f) => relative(base, f).split(sep).join("/"))
        .filter((r) => re.test(r))
        .sort();
      const limit = 500;
      const shown = matches.slice(0, limit);
      const totalAll = walkCount(files);
      return textResult(
        `${shown.map((m) => `  ${m}`).join("\n")}\n\n${matches.length} match(es)${shown.length < matches.length ? ` (showing first ${shown.length})` : ""}. Scanned ${totalAll} files.`
      );
    },
  },
  {
    name: "search_files",
    description:
      "Search file contents with a regular expression (like grep). Returns file:line: text matches. Optionally filter by include glob (e.g. \"*.ts\").",
    parameters: schema.obj({
      pattern: schema.str("Regex pattern to search for"),
      path: schema.str("Directory to search (default: project root)"),
      include: schema.str("Glob filter for file names, e.g. \"*.ts\""),
      literal: schema.bool("Treat pattern as literal text instead of regex"),
    }, ["pattern"]),
    readOnly: true,
    run(args, ctx) {
      const base = args.path ? resolvePath(ctx.cwd, args.path) : ctx.cwd;
      assertInsideProject(ctx.cwd, base);
      if (!existsSync(base)) return errResult(`Directory not found: ${base}`);
      const rawPat = String(args.pattern);
      let re: RegExp;
      try {
        re = new RegExp(args.literal === true ? rawPat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : rawPat, args.caseSensitive === false ? "i" : "");
      } catch (err) {
        return errResult(`Invalid regex: ${(err as Error).message}`);
      }
      const includeRe = args.include ? globToRegExp(String(args.include)) : null;
      const files: string[] = [];
      walk(base, { includeHidden: false, maxEntries: 6000, out: files });
      const out: string[] = [];
      const maxMatches = 200;
      let scanned = 0;
      for (const f of files) {
        if (out.length >= maxMatches) break;
        if (includeRe && !includeRe.test(relative(base, f).split(sep).join("/"))) continue;
        let raw: string;
        try {
          const st = statSync(f);
          if (st.size > 1024 * 1024) continue;
          raw = readFileSync(f, "utf8");
        } catch {
          continue;
        }
        if (looksBinary(f, raw)) continue;
        scanned++;
        const lines = raw.split(/\r?\n/);
        const relPath = relative(base, f).split(sep).join("/");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            out.push(`${relPath}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
            if (out.length >= maxMatches) break;
          }
        }
      }
      return textResult(`${out.join("\n")}\n\n${out.length} match(es) in ${scanned} file(s) scanned${out.length >= maxMatches ? " (capped)" : ""}.`);
    },
  },
];

function walkCount(files: string[]): number {
  return files.length;
}
