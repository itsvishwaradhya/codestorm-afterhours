import type { LlmProvider } from "../receipt/chain.js";
import { syntaxOk } from "./inject.js";

export interface PatchInput {
  file: string;
  broken: string;
  good: string | null;
  errors: string[];
  failingRoutes: string[];
}

export interface Patch {
  file: string;
  description: string;
  patchedBy: string;
  before: string;
  after: string;
}

const SYSTEM = [
  "You are the on-call engineer of a self-healing system. Production is failing because of a recent code change in one Express file.",
  "Fix the bug with the smallest possible change. Keep every other change in the file, including other edits made since the last good version: do not simply copy the old file back.",
  "Do not add dependencies, do not add comments about the fix, and keep the file syntactically valid.",
  'Reply with JSON only: {"description": "one sentence: what was wrong and what you changed", "content": "<the entire fixed file>"}',
].join(" ");

// A compact line diff (good → broken) so the model sees what changed without re-reading both files.
export function changedLines(good: string, broken: string): string {
  const before = good.split(/\r?\n/);
  const after = broken.split(/\r?\n/);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length - 1;
  let endAfter = after.length - 1;
  while (endBefore >= start && endAfter >= start && before[endBefore] === after[endAfter]) {
    endBefore--;
    endAfter--;
  }
  const removed = before.slice(start, endBefore + 1).map((line) => `- ${line}`);
  const added = after.slice(start, endAfter + 1).map((line) => `+ ${line}`);
  return [`@@ line ${start + 1} @@`, ...removed, ...added].join("\n");
}

function parseReply(raw: string): { description: string; content: string } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { description?: unknown; content?: unknown };
    if (typeof parsed.content !== "string" || typeof parsed.description !== "string") return null;
    return { description: parsed.description, content: parsed.content };
  } catch {
    return null;
  }
}

export function patchPrompt(input: PatchInput): string {
  const parts = [`File ${input.file} (the broken version now in production):\n\n${input.broken}`];
  if (input.failingRoutes.length) parts.push(`Failing routes: ${input.failingRoutes.join(", ")}`);
  if (input.errors.length) parts.push(`Recent errors from the app:\n${input.errors.join("\n")}`);
  if (input.good !== null) parts.push(`What changed since the last version that served cleanly:\n${changedLines(input.good, input.broken)}`);
  return parts.join("\n\n");
}

// Asks each provider in turn until one returns a changed file that parses. Whether the fix works
// is decided by the shadow test, not here. Reverting only the bad lines counts as a valid fix.
export async function writePatch(
  providers: LlmProvider[],
  input: PatchInput,
  log: (line: string) => void,
  budgetMs = 30_000,
): Promise<Patch | null> {
  const deadline = Date.now() + budgetMs;
  for (const provider of providers) {
    const remaining = deadline - Date.now();
    if (remaining <= 1000) {
      log("out of time for an AI fix");
      break;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remaining, 25_000));
    try {
      log(`asking ${provider.id} to write a fix for ${input.file}…`);
      const reply = parseReply(await provider.complete(SYSTEM, patchPrompt(input), controller.signal));
      if (!reply || reply.content.trim() === input.broken.trim()) {
        log(`${provider.id} did not return a usable fix`);
        continue;
      }
      if (!(await syntaxOk(input.file, reply.content))) {
        log(`${provider.id}'s fix does not parse, discarded`);
        continue;
      }
      return { file: input.file, description: reply.description, patchedBy: provider.id, before: input.broken, after: reply.content };
    } catch (error) {
      log(`${provider.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
