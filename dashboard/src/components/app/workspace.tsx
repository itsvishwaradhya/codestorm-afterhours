import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { io } from "socket.io-client";
import {
  FAULT_TYPES,
  SERVICE_NAMES,
  type Attempt,
  type AuditEntry,
  type FaultType,
  type Incident,
  type ServiceName,
  type Snapshot,
} from "@nightshift/shared";
import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen, SquareTerminal } from "lucide-react";
import { api, type LogLine, type Scorecard, type WorkspaceFile } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { HEALTH_META, healthOf, humanize, percent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { StateBadge, StatusDot } from "./status";

const CodeEditor = lazy(() => import("./code-editor"));

const DEFAULT_FILE = "services/src/service.ts";
const MAX_LINES = 500;

type Tone = "muted" | "info" | "ok" | "warn" | "error" | "cmd";

interface TermLine {
  id: number;
  at: string;
  tag: string;
  text: string;
  tone: Tone;
}

const TAG_COLOR: Record<string, string> = {
  orders: "text-sky-400",
  payments: "text-violet-400",
  inventory: "text-amber-400",
  healer: "text-emerald-400",
  nightshift: "text-indigo-300",
  $: "text-zinc-400",
};

const TONE_COLOR: Record<Tone, string> = {
  muted: "text-zinc-400",
  info: "text-zinc-200",
  ok: "text-emerald-300",
  warn: "text-amber-300",
  error: "text-rose-300",
  cmd: "text-zinc-50",
};

const STATE_TONE: Partial<Record<Incident["state"], Tone>> = {
  resolved: "ok",
  escalated: "error",
  awaiting_approval: "warn",
  rate_limited: "warn",
  suppressed: "warn",
};

let nextId = 0;
const line = (tag: string, text: string, tone: Tone = "info", at = new Date().toISOString()): TermLine => ({
  id: nextId++,
  at,
  tag,
  text,
  tone,
});

const fromLog = (entry: LogLine): TermLine =>
  line(entry.service, entry.line, entry.stream === "stderr" ? "error" : entry.stream === "supervisor" ? "muted" : "info", entry.at);

// Service output, incident transitions and audit events, merged into one terminal stream.
function useTerminalFeed() {
  const [lines, setLines] = useState<TermLine[]>([]);
  const states = useRef(new Map<string, Incident["state"]>());

  const push = useCallback((...added: TermLine[]) => {
    setLines((current) => [...current, ...added].slice(-MAX_LINES));
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .logs()
      .then((recent) => {
        if (!cancelled) setLines((current) => [...recent.map(fromLog), ...current].slice(-MAX_LINES));
      })
      .catch(() => undefined);

    const socket = io();
    socket.on("log", (entry: LogLine) => push(fromLog(entry)));
    socket.on("incident", (incident: Incident) => {
      const previous = states.current.get(incident.id);
      if (previous === incident.state) return;
      states.current.set(incident.id, incident.state);
      const id = incident.id.slice(0, 8);
      if (!previous && incident.rootCause) {
        const symptoms = incident.symptoms.length ? `, symptoms: ${incident.symptoms.join(", ")}` : "";
        push(line("healer", `incident ${id} opened, root cause ${incident.rootCause}${symptoms}`, "warn"));
      }
      push(line("healer", `incident ${id} → ${humanize(incident.state)}${incident.outcome ? ` (${incident.outcome})` : ""}`, STATE_TONE[incident.state] ?? "info"));
    });
    socket.on("audit", (entry: AuditEntry) => {
      if (entry.actor === "healer" && entry.action.startsWith("incident.")) return;
      push(line(entry.actor === "operator" ? "nightshift" : "healer", `${entry.action}: ${entry.trigger}`, "muted", entry.at));
    });
    return () => {
      cancelled = true;
      socket.disconnect();
    };
  }, [push]);

  return { lines, push, clear: () => setLines([]) };
}

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file?: WorkspaceFile;
}

function buildTree(files: WorkspaceFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const file of files) {
    let node = root;
    const parts = file.path.split("/");
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      if (!node.children.has(part)) node.children.set(part, { name: part, path, children: new Map() });
      node = node.children.get(part)!;
      if (index === parts.length - 1) node.file = file;
    });
  }
  return root;
}

function TreeItem({
  node,
  depth,
  selected,
  open,
  onToggle,
  onOpen,
}: {
  node: TreeNode;
  depth: number;
  selected: string;
  open: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const indent = { paddingLeft: 8 + depth * 12 };
  if (node.file) {
    return (
      <button
        onClick={() => onOpen(node.path)}
        style={indent}
        className={cn(
          "flex w-full items-center gap-1.5 truncate py-1 pr-2 text-left text-[13px] hover:bg-white/5",
          selected === node.path ? "bg-indigo-500/15 text-zinc-50" : "text-zinc-300",
        )}
      >
        <FileCode2 className="size-3.5 shrink-0 text-sky-400" />
        <span className="truncate">{node.name}</span>
      </button>
    );
  }
  const expanded = open.has(node.path);
  const children = [...node.children.values()].sort(
    (a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name),
  );
  return (
    <>
      <button
        onClick={() => onToggle(node.path)}
        style={indent}
        className="flex w-full items-center gap-1 py-1 pr-2 text-left text-[13px] text-zinc-300 hover:bg-white/5"
      >
        {expanded ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        {expanded ? <FolderOpen className="size-3.5 shrink-0 text-amber-300" /> : <Folder className="size-3.5 shrink-0 text-amber-300" />}
        <span className="truncate">{node.name}</span>
      </button>
      {expanded &&
        children.map((child) => (
          <TreeItem key={child.path} node={child} depth={depth + 1} selected={selected} open={open} onToggle={onToggle} onOpen={onOpen} />
        ))}
    </>
  );
}

export interface WorkspaceProps {
  snapshots: Snapshot[];
  incidents: Incident[];
  activeIncident: Incident | null;
  pendingAttempts: Attempt[];
  scorecard: Scorecard | null;
  roleFor: (service: ServiceName) => "root" | "symptom" | null;
  onChaos: (service: ServiceName, fault: FaultType | null) => Promise<void>;
  onDecide: (attemptId: string, decision: "approve" | "reject") => Promise<void>;
}

const HELP = [
  "help                          show this list",
  "status                        live health of every service",
  "chaos <service> <fault>       inject a fault (faults: " + FAULT_TYPES.join(", ") + ")",
  "clear <service>               remove an injected fault by hand",
  "approve | reject              decide the pending risky fix",
  "incidents                     the five most recent incidents",
  "scorecard                     what the guardrails saved",
  "open <file>                   open a source file, e.g. open catalog.ts",
  "cls                           clear the terminal",
];

export function Workspace(props: WorkspaceProps) {
  const { snapshots, incidents, activeIncident, pendingAttempts, scorecard, roleFor, onChaos, onDecide } = props;
  const [files, setFiles] = useState<WorkspaceFile[] | null>(null);
  const [selected, setSelected] = useState(DEFAULT_FILE);
  const [content, setContent] = useState<string | null>(null);
  const [open, setOpen] = useState(() => new Set(["services", "services/src", "healer", "healer/src"]));
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const { lines, push, clear } = useTerminalFeed();
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.workspaceTree().then(setFiles).catch(() => setFiles([]));
  }, []);

  useEffect(() => {
    setContent(null);
    api
      .workspaceFile(selected)
      .then((file) => setContent(file.content))
      .catch(() => setContent(`// could not load ${selected}`));
  }, [selected]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [lines]);

  const tree = useMemo(() => buildTree(files ?? []), [files]);

  const openFile = (path: string) => {
    setSelected(path);
    setOpen((current) => {
      const next = new Set(current);
      path.split("/").slice(0, -1).forEach((_, index, parts) => next.add(parts.slice(0, index + 1).join("/")));
      return next;
    });
  };

  const toggle = (path: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const isService = (value: string | undefined): value is ServiceName => SERVICE_NAMES.includes(value as ServiceName);

  const run = async (raw: string) => {
    const [command, ...args] = raw.trim().split(/\s+/);
    if (!command) return;
    push(line("$", raw.trim(), "cmd"));
    const say = (text: string, tone: Tone = "info") => push(line("nightshift", text, tone));

    switch (command.toLowerCase()) {
      case "help":
        HELP.forEach((entry) => say(entry, "muted"));
        return;
      case "cls":
      case "clear-screen":
        clear();
        return;
      case "status":
        if (snapshots.length === 0) say("no samples yet", "warn");
        for (const name of SERVICE_NAMES) {
          const snapshot = snapshots.find((entry) => entry.service === name);
          const level = healthOf(snapshot);
          const role = roleFor(name);
          say(
            `${name.padEnd(10)} ${HEALTH_META[level].label.padEnd(12)} errors ${snapshot ? percent(snapshot.errorRate).padStart(6) : "     -"}  p95 ${snapshot ? `${Math.round(snapshot.p95LatencyMs)} ms` : "-"}${role ? `  [${role}]` : ""}`,
            level === "healthy" ? "ok" : level === "degraded" ? "warn" : level === "waiting" ? "muted" : "error",
          );
        }
        return;
      case "chaos":
      case "break": {
        const [service, fault] = args;
        if (!isService(service) || !FAULT_TYPES.includes(fault as FaultType)) {
          say(`usage: chaos <${SERVICE_NAMES.join("|")}> <${FAULT_TYPES.join("|")}>`, "error");
          return;
        }
        await onChaos(service, fault as FaultType);
        say(`injected ${fault} on ${service}; NightShift is watching`, "warn");
        return;
      }
      case "clear": {
        const [service] = args;
        if (!isService(service)) {
          say(`usage: clear <${SERVICE_NAMES.join("|")}>`, "error");
          return;
        }
        await onChaos(service, null);
        say(`cleared the fault on ${service}`, "ok");
        return;
      }
      case "approve":
      case "reject": {
        const attempt = pendingAttempts[0];
        if (!attempt) {
          say("nothing is waiting for approval", "muted");
          return;
        }
        await onDecide(attempt.id, command.toLowerCase() as "approve" | "reject");
        say(`${command.toLowerCase()}d: ${attempt.label}`, command.toLowerCase() === "approve" ? "ok" : "warn");
        return;
      }
      case "incidents":
        if (incidents.length === 0) say("no incidents yet", "muted");
        for (const incident of incidents.slice(0, 5)) {
          say(
            `${incident.id.slice(0, 8)}  ${humanize(incident.state).padEnd(17)} ${incident.rootCause ?? "-"}  ${incident.outcome ?? ""}`,
            STATE_TONE[incident.state] ?? "info",
          );
        }
        return;
      case "scorecard": {
        if (!scorecard) {
          say("scorecard not loaded yet", "muted");
          return;
        }
        const fix = scorecard.timeToFix;
        say(`symptom restarts avoided  ${scorecard.symptomRestartsAvoided}`);
        say(`unproven fixes blocked    ${scorecard.unprovenFixesBlocked}`);
        say(`risky fixes held          ${scorecard.riskyFixesHeld}`);
        say(`restart storms stopped    ${scorecard.restartStormsStopped}`);
        say(`bad fixes rolled back     ${scorecard.badFixesRolledBack}`);
        say(`median time to fix        ${fix.medianSeconds !== null ? `${fix.medianSeconds}s over ${fix.count} heal(s)` : "-"}`, "ok");
        return;
      }
      case "open": {
        const [name] = args;
        const match = (files ?? []).find((file) => file.path === name || file.path.endsWith(`/${name}`));
        if (!match) {
          say(`no workspace file matches ${name ?? "''"}`, "error");
          return;
        }
        openFile(match.path);
        say(`opened ${match.path}`, "muted");
        return;
      }
      default:
        say(`unknown command: ${command}. Type help.`, "error");
    }
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      const value = input;
      setInput("");
      setCursor(null);
      if (value.trim()) setHistory((current) => [...current, value].slice(-50));
      void run(value);
    } else if (event.key === "ArrowUp" && history.length) {
      event.preventDefault();
      const index = cursor === null ? history.length - 1 : Math.max(0, cursor - 1);
      setCursor(index);
      setInput(history[index]);
    } else if (event.key === "ArrowDown" && cursor !== null) {
      event.preventDefault();
      const index = cursor + 1;
      setCursor(index >= history.length ? null : index);
      setInput(index >= history.length ? "" : history[index]);
    }
  };

  return (
    <div className="grid h-[calc(100vh-7.5rem)] min-h-[600px] gap-3 lg:grid-cols-[230px_minmax(0,1fr)_290px]">
      {/* Explorer */}
      <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-[#1b1b1f]">
        <header className="border-b border-white/10 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-zinc-400">
          Explorer · checkout-demo
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {files === null
            ? Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="mx-3 my-1.5 h-4" />)
            : [...tree.children.values()].map((node) => (
                <TreeItem key={node.path} node={node} depth={0} selected={selected} open={open} onToggle={toggle} onOpen={openFile} />
              ))}
        </div>
      </section>

      {/* Editor + terminal */}
      <section className="flex min-h-0 flex-col gap-3">
        <div className="flex min-h-0 flex-[3] flex-col overflow-hidden rounded-xl border border-white/10 bg-[#1e1e1e]">
          <header className="flex items-center justify-between border-b border-white/10 bg-[#252526] px-3 py-1.5">
            <span className="flex items-center gap-1.5 font-mono text-xs text-zinc-200">
              <FileCode2 className="size-3.5 text-sky-400" />
              {selected}
            </span>
            <Badge variant="outline" className="font-mono text-[10px]">read-only</Badge>
          </header>
          <div className="min-h-0 flex-1">
            <Suspense fallback={<Skeleton className="m-4 h-40" />}>
              {content === null ? <Skeleton className="m-4 h-40" /> : <CodeEditor path={selected} content={content} />}
            </Suspense>
          </div>
        </div>

        <div
          className="flex min-h-0 flex-[2] flex-col overflow-hidden rounded-xl border border-white/10 bg-[#0d0d10]"
          onClick={() => inputRef.current?.focus()}
        >
          <header className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5 text-xs text-zinc-300">
            <SquareTerminal className="size-3.5 text-emerald-400" />
            Terminal
            <span className="text-zinc-500">· live service output + NightShift commands (type help)</span>
          </header>
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[12.5px] leading-relaxed">
            {lines.length === 0 && <p className="text-zinc-500">Waiting for output… type help to see what you can run.</p>}
            {lines.map((entry) => (
              <div key={entry.id} className="flex gap-2 whitespace-pre-wrap break-words">
                <span className="shrink-0 text-zinc-600">{entry.at.slice(11, 19)}</span>
                <span className={cn("shrink-0", TAG_COLOR[entry.tag] ?? "text-zinc-400")}>
                  {entry.tag === "$" ? "$" : `[${entry.tag}]`}
                </span>
                <span className={TONE_COLOR[entry.tone]}>{entry.text}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 border-t border-white/10 px-3 py-2 font-mono text-[13px]">
            <span className="text-emerald-400">nightshift $</span>
            <input
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKey}
              spellCheck={false}
              autoComplete="off"
              placeholder="chaos payments crash"
              className="min-w-0 flex-1 bg-transparent text-zinc-50 outline-none placeholder:text-zinc-600"
              aria-label="Terminal command"
            />
          </div>
        </div>
      </section>

      {/* Live system */}
      <section className="flex min-h-0 flex-col gap-3 overflow-y-auto">
        <div className="rounded-xl border bg-card p-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Live system</p>
          <ul className="space-y-2">
            {SERVICE_NAMES.map((name) => {
              const snapshot = snapshots.find((entry) => entry.service === name);
              const meta = HEALTH_META[healthOf(snapshot)];
              const role = roleFor(name);
              return (
                <li key={name} className="rounded-lg border bg-background/40 px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <StatusDot className={meta.dot} pulse={meta.label !== "Operational"} />
                      {name}
                    </span>
                    {role ? (
                      <Badge variant={role === "root" ? "destructive" : "warning"}>{role === "root" ? "root cause" : "symptom"}</Badge>
                    ) : (
                      <Badge variant={meta.variant}>{meta.label}</Badge>
                    )}
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                    {snapshot
                      ? `err ${percent(snapshot.errorRate)} · p95 ${Math.round(snapshot.p95LatencyMs)} ms · ${Math.round(snapshot.memoryMb)} MB`
                      : "waiting for samples"}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="rounded-xl border bg-card p-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">NightShift</p>
          {activeIncident ? (
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs">{activeIncident.id.slice(0, 8)}</span>
                <StateBadge state={activeIncident.state} />
              </div>
              <p className="text-muted-foreground">
                Root cause <span className="font-medium text-foreground">{activeIncident.rootCause ?? "diagnosing…"}</span>
                {activeIncident.symptoms.length > 0 && <> · symptoms {activeIncident.symptoms.join(", ")}</>}
              </p>
              {pendingAttempts[0] && (
                <p className="rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-1.5 text-xs text-amber-200">
                  Waiting for approval: {pendingAttempts[0].label}. Type <code>approve</code> or <code>reject</code>.
                </p>
              )}
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <StatusDot className="bg-emerald-400" pulse />
              On watch. Try <code className="text-foreground">chaos payments crash</code>.
            </p>
          )}
        </div>

        {scorecard && (
          <div className="rounded-xl border bg-card p-3 text-sm">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Guardrails</p>
            <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-muted-foreground">
              <dt>Median time to fix</dt>
              <dd className="font-mono text-foreground">
                {scorecard.timeToFix.medianSeconds !== null ? `${scorecard.timeToFix.medianSeconds}s` : "-"}
              </dd>
              <dt>Symptom restarts avoided</dt>
              <dd className="font-mono text-foreground">{scorecard.symptomRestartsAvoided}</dd>
              <dt>Restart storms stopped</dt>
              <dd className="font-mono text-foreground">{scorecard.restartStormsStopped}</dd>
              <dt>Risky fixes held</dt>
              <dd className="font-mono text-foreground">{scorecard.riskyFixesHeld}</dd>
            </dl>
          </div>
        )}
      </section>
    </div>
  );
}
