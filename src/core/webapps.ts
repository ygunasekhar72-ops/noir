import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";

/**
 * Project web apps: self-contained static sites a project ships under
 * `<project>/.noir/webapps/<name>/`, served by `noir serve` at
 * `/apps/<name>/`. Each app gets a writable data area at
 * `<name>/data/` exposed through the app-data API — files stored there are
 * plain project files, so the NOIR agent can read/write them with its
 * normal file tools.
 */

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/i;

export function isValidWebAppName(name: string): boolean {
  return NAME_RE.test(name);
}

export function webAppsDir(projectDir: string): string {
  return join(projectDir, ".noir", "webapps");
}

export function webAppRoot(projectDir: string, name: string): string | null {
  if (!isValidWebAppName(name)) return null;
  return join(webAppsDir(projectDir), name.toLowerCase());
}

export function webAppDataRoot(projectDir: string, name: string): string | null {
  const root = webAppRoot(projectDir, name);
  return root ? join(root, "data") : null;
}

/** Sanitize a relative file path for app-data access; throws on traversal. */
export function safeAppFile(dataRoot: string, file: string): string {
  if (typeof file !== "string" || !file.trim() || file.length > 240 || /^\/|^\\\\|^~/.test(file) || file.includes("..") || /[<>:|?*\x00-\x1f]/.test(file)) {
    throw new Error(`invalid file path: ${JSON.stringify(String(file).slice(0, 60))}`);
  }
  const full = join(dataRoot, file);
  const rel = relative(dataRoot, full);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("path escapes the app data directory");
  return full;
}

export function listWebApps(projectDir: string): string[] {
  const dir = webAppsDir(projectDir);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => NAME_RE.test(f) && statSync(join(dir, f)).isDirectory())
      .sort();
  } catch {
    return [];
  }
}
