import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { globalDir, packageRoot } from "../config.js";
import type { Logger } from "../logger.js";

/**
 * NOIR skills — portable instruction packs (SKILL.md with YAML frontmatter,
 * compatible with the Claude/OpenCode skills layout).
 *
 * Search order: project .noir/skills -> global ~/.noir/skills -> built-in package skills.
 */

export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
  path: string;
  source: "project" | "global" | "builtin";
  when?: string;
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) {
    // first line may be "# Name" heading style
    return { meta: {}, body: raw.trim() };
  }
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
  }
  return { meta, body: m[2].trim() };
}

function dirSkills(dir: string, source: Skill["source"], logger: Logger): Skill[] {
  const out: Skill[] = [];
  if (!existsSync(dir)) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry);
    let skillDir = full;
    let mdName = "SKILL.md";
    try {
      if (!statSync(full).isDirectory()) {
        // flat file form: <id>.md
        if (entry.endsWith(".md")) {
          const raw = readFileSync(full, "utf8");
          const { meta, body } = parseFrontmatter(raw);
          const id = entry.replace(/\.md$/, "");
          out.push({
            id,
            name: meta.name ?? id,
            description: meta.description ?? meta.when ?? "",
            when: meta.when,
            body,
            path: full,
            source,
          });
        }
        continue;
      }
    } catch {
      continue;
    }
    // directory form: <dir>/SKILL.md (or any .md inside)
    try {
      const files = readdirSync(skillDir);
      if (files.includes("SKILL.md")) mdName = "SKILL.md";
      else {
        const md = files.find((f) => f.endsWith(".md"));
        if (!md) continue;
        mdName = md;
      }
      const raw = readFileSync(join(skillDir, mdName), "utf8");
      const { meta, body } = parseFrontmatter(raw);
      const id = meta.name ?? entry;
      out.push({
        id: slug(id),
        name: id,
        description: meta.description ?? meta.when ?? "",
        when: meta.when,
        body,
        path: join(skillDir, mdName),
        source,
      });
    } catch (err) {
      logger.warn(`skill "${entry}" failed to load: ${(err as Error).message}`);
    }
  }
  return out;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

export class SkillManager {
  private skills = new Map<string, Skill>();

  constructor(
    private projectDir: string,
    private logger: Logger
  ) {}

  load(): Skill[] {
    this.skills.clear();
    const sources: Array<[string, Skill["source"]]> = [
      [join(this.projectDir, ".noir", "skills"), "project"],
      [join(globalDir(), "skills"), "global"],
      [join(packageRoot(), "skills"), "builtin"],
    ];
    for (const [dir, source] of sources) {
      for (const s of dirSkills(dir, source, this.logger)) {
        if (source !== "project" && this.skills.has(s.id)) continue; // project overrides
        this.skills.set(s.id, s);
      }
    }
    return [...this.skills.values()];
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id) ?? [...this.skills.values()].find((s) => s.name.toLowerCase() === id.toLowerCase());
  }

  /** Compact list block for the system prompt. */
  systemBlock(): string {
    const all = this.list();
    if (!all.length) return "";
    const lines = all.map((s) => `- ${s.id}: ${s.description || "(no description)"} [${s.source}]`);
    return `### Skills (invoke with the use_skill tool)\n${lines.join("\n")}`;
  }
}
