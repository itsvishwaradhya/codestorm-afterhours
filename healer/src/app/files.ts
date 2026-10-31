import { cp, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";
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

// Empties the app folder rather than deleting it: on Windows the folder itself stays locked
// (EBUSY) for a moment after the terminal that sat in it is killed.
export async function resetApp(): Promise<void> {
  await mkdir(APP_ROOT, { recursive: true });
  for (const entry of await readdir(APP_ROOT)) {
    await rm(path.join(APP_ROOT, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  await rm(GOOD_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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

export interface TreeEntry {
  path: string;
  size: number;
  dir?: boolean;
}

// Files plus folders (so an empty new folder still shows in the explorer).
export async function listTree(root = APP_ROOT): Promise<TreeEntry[]> {
  const out: TreeEntry[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        out.push({ path: relative, size: 0, dir: true });
        await walk(absolute);
      } else {
        out.push({ path: relative, size: (await stat(absolute)).size });
      }
    }
  };
  await walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function makeAppDir(relative: string): Promise<boolean> {
  const absolute = resolveAppPath(relative);
  if (!absolute) return false;
  await mkdir(absolute, { recursive: true });
  return true;
}

export async function deleteAppPath(relative: string): Promise<boolean> {
  const absolute = resolveAppPath(relative);
  if (!absolute) return false;
  await rm(absolute, { recursive: true, force: true });
  return true;
}

export async function renameAppPath(from: string, to: string): Promise<boolean> {
  const source = resolveAppPath(from);
  const target = resolveAppPath(to);
  if (!source || !target || (await stat(target).then(() => true, () => false))) return false;
  await mkdir(path.dirname(target), { recursive: true });
  await rename(source, target);
  return true;
}

const sourceOnly =(root: string) => (source: string) => !path.relative(root, source).split(path.sep).some((part) => SKIP.has(part));

// Last known good copy of the source (no node_modules), taken before every injected change.
// Copied aside first and swapped in, so a failed copy never leaves the app without a good version.
export async function snapshotGood(): Promise<void> {
  const staging = `${GOOD_ROOT}.next`;
  await rm(staging, { recursive: true, force: true });
  await cp(APP_ROOT, staging, { recursive: true, filter: sourceOnly(APP_ROOT) });
  await rm(GOOD_ROOT, { recursive: true, force: true });
  await rename(staging, GOOD_ROOT);
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

// Minimal ZIP writer (stored, no compression): enough for a source tree without a dependency.
export function zipEntries(entries: { path: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, entry.data);
    centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export async function zipApp(): Promise<Buffer> {
  const entries: { path: string; data: Buffer }[] = [];
  for (const file of await listFiles()) {
    const absolute = resolveAppPath(file.path);
    if (absolute) entries.push({ path: file.path, data: await readFile(absolute) });
  }
  return zipEntries(entries);
}
