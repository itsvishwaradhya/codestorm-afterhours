import { spawnSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LlmProvider } from "../receipt/chain.js";
import { APP_ROOT, listFiles, readAppFile } from "./files.js";

const HANDLER = /(?:app|router)\.get\(\s*(['"`])([^'"`]+)\1\s*,[^{]*?(?:=>|function\s*\w*\s*\([^)]*\))\s*\{/g;
const CODE_FILE = /\.(c|m)?js$/;

export interface Injection {
  file: string;
  route: string;
  kind: BugKind | null;
  description: string;
  injectedBy: string;
  before: string;
  after: string;
}

export const BUG_KINDS = ["null_deref", "bad_parse", "error_response", "intermittent", "process_crash"] as const;
export type BugKind = (typeof BUG_KINDS)[number];

// Every kind is one NightShift can see: it fails requests or takes the app down.
export const BUG_CATALOG: Record<BugKind, { label: string; effect: string; prompt: string }> = {
  null_deref: {
    label: "Null dereference",
    effect: "every request throws a TypeError (HTTP 500)",
    prompt: "read a property of a value that is now always undefined, so the handler throws a TypeError on every request",
  },
  bad_parse: {
    label: "Bad input parsing",
    effect: "every request throws a SyntaxError from JSON.parse (HTTP 500)",
    prompt: "JSON.parse a value that is never valid JSON (for example a header or query parameter clients do not send), so every request throws",
  },
  error_response: {
    label: "Wrong error path",
    effect: "the route answers HTTP 500 instead of its data",
    prompt: "take a wrong branch so the handler responds with HTTP 500 and an error message instead of its normal data, without throwing",
  },
  intermittent: {
    label: "Intermittent failure",
    effect: "about half of the requests fail (HTTP 500)",
    prompt: "fail about half of the requests based on something that changes per request (for example the parity of Date.now()), while the rest still succeed",
  },
  process_crash: {
    label: "Process crash",
    effect: "the first request crashes the whole Node process (app unreachable)",
    prompt: "throw from an asynchronous callback (for example inside setImmediate) so the error is uncaught and the Node process exits",
  },
};

// Random picks leave out "intermittent": on a busy app it can stay under the alert line, and a
// random demo should always produce an incident.
export const RANDOM_KINDS: BugKind[] = ["null_deref", "bad_parse", "error_response", "process_crash"];

export const pick = <T>(list: readonly T[], random: () => number = Math.random): T | undefined =>
  list.length ? list[Math.floor(random() * list.length) % list.length] : undefined;

export interface InjectOptions {
  route?: string;
  kind?: BugKind;
}

export interface InjectTarget {
  file: string;
  route: string;
}

function systemPrompt(route: string, kind: BugKind | undefined): string {
  return [
    "You are the chaos tool of a self-healing demo. You inject exactly one realistic production bug into an Express route file.",
    `Break the GET ${route} handler and no other route.`,
    kind
      ? `The bug must ${BUG_CATALOG[kind].prompt}.`
      : "The bug must make this route throw or return HTTP 500 on most requests, every time it is called with the same input (for example dereferencing a value that is now always undefined, a wrong property name, or JSON.parse of a non-JSON string). A bug that only fires on rare input is useless.",
    "Keep the file syntactically valid, keep every other route unchanged, add no dependencies, and add no comment that reveals the bug.",
    `Reply with JSON only: {"route": "${route}", "description": "one sentence an engineer would write in a postmortem", "content": "<the entire modified file>"}`,
  ].join(" ");
}

// GET routes with a static path: the ones NightShift's traffic exercises, so a bug there is seen.
export function targetsIn(file: string, source: string): InjectTarget[] {
  return [...source.matchAll(HANDLER)].filter((match) => !/[:*]/.test(match[2])).map((match) => ({ file, route: match[2] }));
}

export async function listTargets(): Promise<InjectTarget[]> {
  const targets: InjectTarget[] = [];
  for (const file of await listFiles()) {
    if (CODE_FILE.test(file.path)) targets.push(...targetsIn(file.path, (await readAppFile(file.path)) ?? ""));
  }
  return targets;
}


// `node --check` next to the original, so the package's module type applies.
export async function syntaxOk(file: string, content: string): Promise<boolean> {
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

const SCRIPTED: Record<BugKind, { code: string; description: (route: string) => string }> = {
  null_deref: {
    code: "\n  const owner = req.query.owner;\n  if (owner.length === 0) return res.status(400).end();",
    description: (route) => `GET ${route} now reads .length of a query parameter that clients never send`,
  },
  bad_parse: {
    code: '\n  const filters = JSON.parse(req.headers["x-filters"] ?? "");\n  void filters;',
    description: (route) => `GET ${route} now JSON-parses a header that clients never send`,
  },
  error_response: {
    code: '\n  if (!process.env.FEATURE_STORE_URL) return res.status(500).json({ error: "feature store not configured" });',
    description: (route) => `GET ${route} now returns 500 when an optional setting is missing`,
  },
  intermittent: {
    code: '\n  const replica = Date.now() % 2 === 0 ? undefined : { ready: true };\n  if (!replica.ready) throw new Error("replica unavailable");',
    description: (route) => `GET ${route} now reads from a replica that is missing on about half of the requests`,
  },
  process_crash: {
    code: '\n  setImmediate(() => {\n    throw new Error("cache warmup failed");\n  });',
    description: (route) => `GET ${route} now throws from a background callback, which takes the whole process down`,
  },
};

// Deterministic fallback: the chosen bug at the top of the chosen GET handler (or the first one).
export function scriptedBug(source: string, route?: string, kind: BugKind = "null_deref"): { description: string; content: string } | null {
  const match = [...source.matchAll(HANDLER)].find((candidate) => !route || candidate[2] === route);
  if (!match || match.index === undefined) return null;
  const insertAt = match.index + match[0].length;
  return {
    description: SCRIPTED[kind].description(match[2]),
    content: source.slice(0, insertAt) + SCRIPTED[kind].code + source.slice(insertAt),
  };
}

// Confirms a candidate bug really breaks the app before it is deployed.
export type BugCheck = (file: string, content: string) => Promise<boolean>;

export async function injectBug(
  providers: LlmProvider[],
  log: (line: string) => void,
  breaksApp: BugCheck = async () => true,
  options: InjectOptions = {},
  random: () => number = Math.random,
): Promise<Injection | null> {
  const targets = await listTargets();
  const target = options.route ? targets.find((candidate) => candidate.route === options.route) : pick(targets, random);
  if (!target) {
    log(options.route ? `no GET ${options.route} handler found to break` : "no Express GET routes found to break");
    return null;
  }
  const { file, route } = target;
  // Unless asked for one, every click picks a fresh route and kind, so no two demos are alike.
  const kind = options.kind ?? pick(RANDOM_KINDS, random)!;
  log(`target: GET ${route} in ${file}; bug: ${BUG_CATALOG[kind].label.toLowerCase()}${options.kind ? "" : " (picked at random)"}`);
  const before = (await readAppFile(file)) ?? "";

  for (const provider of providers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      log(`asking ${provider.id} to inject a bug into GET ${route} (${file})…`);
      const reply = parseReply(await provider.complete(systemPrompt(route, kind), `File ${file}:\n\n${before}`, controller.signal));
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
      return { file, route, kind, description: reply.description, injectedBy: provider.id, before, after: reply.content };
    } catch (error) {
      log(`${provider.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  const scripted = scriptedBug(before, route, kind);
  if (!scripted || !(await syntaxOk(file, scripted.content))) {
    log("could not inject a bug into this app");
    return null;
  }
  // The user picked this bug, so it goes in either way; just say if it is too small to notice.
  if (!(await breaksApp(file, scripted.content))) {
    log(`warning: GET ${route} is a small share of the traffic, so this bug may stay under NightShift's alert threshold`);
  }
  return { file, route, kind, ...scripted, injectedBy: "scripted", before, after: scripted.content };
}
