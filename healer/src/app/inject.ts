import { spawnSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LlmProvider } from "../receipt/chain.js";
import { APP_ROOT, listFiles, readAppFile } from "./files.js";

const ROUTE_CALL = /(?:app|router)\.get\(/g;
const CODE_FILE = /\.(c|m)?js$/;

export interface Injection {
  file: string;
  description: string;
  injectedBy: string;
  before: string;
  after: string;
}

const SYSTEM = [
  "You are the chaos tool of a self-healing demo. You inject exactly one realistic production bug into an Express route file.",
  "The bug must make one GET route throw or return HTTP 500 on most requests, every time it is called with the same input (for example dereferencing a value that is now always undefined, a wrong property name, or JSON.parse of a non-JSON string). A bug that only fires on rare input is useless.",
  "Keep the file syntactically valid, keep every other route unchanged, add no dependencies, and add no comment that reveals the bug.",
  'Reply with JSON only: {"route": "/path", "description": "one sentence an engineer would write in a postmortem", "content": "<the entire modified file>"}',
].join(" ");

export async function pickTarget(): Promise<string | null> {
  let best: { path: string; routes: number } | null = null;
  for (const file of await listFiles()) {
    if (!CODE_FILE.test(file.path)) continue;
    const content = (await readAppFile(file.path)) ?? "";
    const routes = content.match(ROUTE_CALL)?.length ?? 0;
    if (routes > 0 && (!best || routes > best.routes)) best = { path: file.path, routes };
  }
  return best?.path ?? null;
}

// `node --check` next to the original, so the package's module type applies.
async function syntaxOk(file: string, content: string): Promise<boolean> {
  const absolute = path.join(APP_ROOT, file);
  const probe = absolute.replace(CODE_FILE, (ext) => `.nscheck${ext}`);
  await writeFile(probe, content);
  try {
    return spawnSync(process.execPath, ["--check", probe], { stdio: "ignore" }).status === 0;
  } finally {
    await rm(probe, { force: true });
  }
}

function parseReply(raw: string): { description: string; content: string } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { description?: unknown; content?: unknown; route?: unknown };
    if (typeof parsed.content !== "string" || typeof parsed.description !== "string") return null;
    const route = typeof parsed.route === "string" ? ` (${parsed.route})` : "";
    return { description: `${parsed.description}${route}`, content: parsed.content };
  } catch {
    return null;
  }
}

// Deterministic fallback: throw at the top of the first GET handler most of the time.
export function scriptedBug(source: string): { description: string; content: string } | null {
  const handler = /(?:app|router)\.get\(\s*(['"`])([^'"`]+)\1\s*,[^{]*?(?:=>|function\s*\w*\s*\([^)]*\))\s*\{/;
  const match = handler.exec(source);
  if (!match) return null;
  const insertAt = match.index + match[0].length;
  const bug = '\n  const item = Math.random() < 0.8 ? undefined : { id: 1 };\n  if (!item.id) throw new Error("lookup failed");';
  return {
    description: `GET ${match[2]} now reads a property of a lookup result that is usually undefined`,
    content: source.slice(0, insertAt) + bug + source.slice(insertAt),
  };
}

// Confirms a candidate bug really breaks the app before it is deployed.
export type BugCheck = (file: string, content: string) => Promise<boolean>;

export async function injectBug(
  providers: LlmProvider[],
  log: (line: string) => void,
  breaksApp: BugCheck = async () => true,
): Promise<Injection | null> {
  const file = await pickTarget();
  if (!file) {
    log("no Express GET routes found to break");
    return null;
  }
  const before = (await readAppFile(file)) ?? "";

  for (const provider of providers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      log(`asking ${provider.id} to inject a bug into ${file}…`);
      const reply = parseReply(await provider.complete(SYSTEM, `File ${file}:\n\n${before}`, controller.signal));
      if (!reply || reply.content.trim() === before.trim()) {
        log(`${provider.id} reply was not a usable change`);
        continue;
      }
      if (!(await syntaxOk(file, reply.content))) {
        log(`${provider.id} produced code that does not parse, discarded`);
        continue;
      }
      log(`${provider.id} wrote: ${reply.description}. Checking it really breaks the app…`);
      if (!(await breaksApp(file, reply.content))) {
        log(`${provider.id}'s bug did not break any request in a test run, discarded`);
        continue;
      }
      return { file, description: reply.description, injectedBy: provider.id, before, after: reply.content };
    } catch (error) {
      log(`${provider.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  const scripted = scriptedBug(before);
  if (!scripted || !(await syntaxOk(file, scripted.content))) {
    log("could not inject a bug into this app");
    return null;
  }
  return { file, ...scripted, injectedBy: "scripted", before, after: scripted.content };
}
