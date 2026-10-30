import { cp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const WORKSPACES = path.join(REPO_ROOT, "workspaces");
export const APP_ROOT = path.join(WORKSPACES, "app");
export const GOOD_ROOT = path.join(WORKSPACES, ".good");

const SKIP = new Set(["node_modules", ".git"]);
export const MAX_FILE_BYTES = 200 * 1024;

// Resolves a path inside an uploaded app, or null when it escapes the root or touches a skipped folder.
export function resolveAppPath(relative: string, root = APP_ROOT): string | null {
  if (!relative || relative.includes("\0")) return null;
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(path.resolve(root) + path.sep)) return null;
  const parts = path.relative(root, absolute).split(path.sep);
  if (parts.some((part) => SKIP.has(part))) return null;
  return absolute;
}

export async function resetApp(): Promise<void> {
  await rm(APP_ROOT, { recursive: true, force: true });
  await rm(GOOD_ROOT, { recursive: true, force: true });
  await mkdir(APP_ROOT, { recursive: true });
}

export async function writeAppFile(relative: string, content: string): Promise<boolean> {
  const absolute = resolveAppPath(relative);
  if (!absolute || Buffer.byteLength(content) > MAX_FILE_BYTES) return false;
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  return true;
}

export async function readAppFile(relative: string, root = APP_ROOT): Promise<string | null> {
  const absolute = resolveAppPath(relative, root);
  if (!absolute) return null;
  return readFile(absolute, "utf8").catch(() => null);
}

export async function listFiles(root = APP_ROOT): Promise<{ path: string; size: number }[]> {
  const out: { path: string; size: number }[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else out.push({ path: path.relative(root, absolute).split(path.sep).join("/"), size: (await stat(absolute)).size });
    }
  };
  await walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const sourceOnly = (root: string) => (source: string) => !path.relative(root, source).split(path.sep).some((part) => SKIP.has(part));

// Last known good copy of the source (no node_modules), taken before every injected change.
export async function snapshotGood(): Promise<void> {
  await rm(GOOD_ROOT, { recursive: true, force: true });
  await cp(APP_ROOT, GOOD_ROOT, { recursive: true, filter: sourceOnly(APP_ROOT) });
}

export async function hasGoodSnapshot(): Promise<boolean> {
  return stat(GOOD_ROOT).then(() => true, () => false);
}

export async function restoreGood(): Promise<void> {
  for (const file of await listFiles(GOOD_ROOT)) {
    await cp(path.join(GOOD_ROOT, file.path), path.join(APP_ROOT, file.path));
  }
}

export async function changedFiles(): Promise<string[]> {
  const changed: string[] = [];
  for (const file of await listFiles(GOOD_ROOT)) {
    const [good, current] = await Promise.all([readAppFile(file.path, GOOD_ROOT), readAppFile(file.path)]);
    if (good !== current) changed.push(file.path);
  }
  return changed;
}

export async function removeClone(directory: string): Promise<void> {
  // Remove the node_modules junction first so rm never walks into the real dependencies.
  await rm(path.join(directory, "node_modules"), { force: true }).catch(() => undefined);
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

// A runnable copy of `source` for a shadow test; node_modules is linked, not copied.
export async function prepareClone(source: string, port: number): Promise<string> {
  const target = path.join(WORKSPACES, `.clone-${port}`);
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true, filter: sourceOnly(source) });
  const modules = path.join(APP_ROOT, "node_modules");
  if (await stat(modules).then(() => true, () => false)) {
    await symlink(modules, path.join(target, "node_modules"), "junction");
  }
  return target;
}
