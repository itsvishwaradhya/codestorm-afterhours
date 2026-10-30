import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// Read-only view of our own source for the dashboard workspace. Only these roots and only
// TypeScript files are served; nothing here can write or execute.
export const WORKSPACE_ROOTS = ["services/src", "healer/src", "shared/src"];
const EXTENSIONS = [".ts"];

export interface WorkspaceFile {
  path: string;
  size: number;
}

// Returns the absolute path for a repo-relative path, or null when it falls outside the allowlist.
export function resolveWorkspacePath(relative: string, root = REPO_ROOT): string | null {
  if (relative.includes("\0")) return null;
  const absolute = path.resolve(root, relative);
  const allowed = WORKSPACE_ROOTS.some((prefix) => {
    const base = path.resolve(root, prefix);
    return absolute.startsWith(base + path.sep);
  });
  if (!allowed || !EXTENSIONS.includes(path.extname(absolute))) return null;
  return absolute;
}

async function walk(directory: string, root: string, out: WorkspaceFile[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(absolute, root, out);
    } else if (EXTENSIONS.includes(path.extname(entry.name))) {
      const content = await readFile(absolute);
      out.push({ path: path.relative(root, absolute).split(path.sep).join("/"), size: content.length });
    }
  }
}

export async function workspaceTree(root = REPO_ROOT): Promise<WorkspaceFile[]> {
  const files: WorkspaceFile[] = [];
  for (const prefix of WORKSPACE_ROOTS) {
    await walk(path.resolve(root, prefix), root, files).catch(() => undefined);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function workspaceFile(relative: string, root = REPO_ROOT): Promise<string | null> {
  const absolute = resolveWorkspacePath(relative, root);
  if (!absolute) return null;
  return readFile(absolute, "utf8");
}
