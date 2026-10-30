import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { io } from "socket.io-client";
import { Bug, CheckCircle2, FileCode2, FolderUp, Loader2, Play, ShieldAlert, Square, SquareTerminal, XCircle } from "lucide-react";
import { api, type AppIncident, type AppLog, type AppState, type WorkspaceFile } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { percent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { StatusDot } from "./status";
import { TAG_COLOR, TONE_COLOR, TreeItem, buildTree, line, type TermLine, type Tone } from "./workspace";

const CodeEditor = lazy(() => import("./code-editor"));

const MAX_LINES = 600;
const MAX_UPLOAD_BYTES = 200 * 1024;
const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|build|coverage)\//;
const TEXT_FILE = /\.(c|m)?(j|t)sx?$|\.(json|md|txt|env\.example|html|css|ya?ml)$|(^|\/)[^.]+$/;
const ENTRY_FILES = ["server.js", "index.js", "app.js", "src/server.js", "src/index.js", "src/app.js"];

const PHASE_META: Record<AppIncident["phase"], { label: string; variant: "destructive" | "warning" | "success" | "default" | "muted" }> = {
  detected: { label: "Detected", variant: "destructive" },
  verifying: { label: "Shadow testing", variant: "warning" },
  promoting: { label: "Applying fix", variant: "warning" },
  watching: { label: "Watching", variant: "default" },
  resolved: { label: "Resolved", variant: "success" },
  escalated: { label: "Escalated", variant: "destructive" },
};

const HELP = [
  "npm install / npm start / node server.js   any command runs in your app folder",
  "                                          (npm start, npm run dev, node <file> become the watched server)",
  "inject                                    let the AI inject a bug into your code",
  "stop                                      stop the app",
  "status                                    health as NightShift sees it",
  "open <file>                               open a file in the editor",
  "cls                                       clear the terminal",
];

function toneFor(entry: AppLog): Tone {
  if (entry.stream === "stderr") return "error";
  if (entry.source === "nightshift") return entry.stream === "stdout" ? "ok" : "warn";
  if (entry.stream === "system") return "muted";
  return "info";
}

export function AppWorkspace() {
  const [files, setFiles] = useState<WorkspaceFile[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [state, setState] = useState<AppState | null>(null);
  const [incident, setIncident] = useState<AppIncident | null>(null);
  const [lines, setLines] = useState<TermLine[]>([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [injecting, setInjecting] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  const push = useCallback((...added: TermLine[]) => setLines((current) => [...current, ...added].slice(-MAX_LINES)), []);
  const say = useCallback((text: string, tone: Tone = "info") => push(line("nightshift", text, tone)), [push]);

  const loadFile = useCallback((path: string) => {
    setSelected(path);
    setContent(null);
    api.app
      .file(path)
      .then((file) => setContent(file.content))
      .catch(() => setContent(`// could not load ${path}`));
  }, []);

  const showFiles = useCallback(
    (list: WorkspaceFile[]) => {
      setFiles(list);
      setOpen(new Set(list.flatMap((file) => file.path.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/")))));
      const entry =
        ENTRY_FILES.find((name) => list.some((file) => file.path === name)) ??
        list.find((file) => /\.(c|m)?js$/.test(file.path))?.path ??
        list[0]?.path;
      if (entry && !selectedRef.current) loadFile(entry);
    },
    [loadFile],
  );

  useEffect(() => {
    api.app.tree().then(showFiles).catch(() => setFiles([]));
    const refresh = () => api.app.state().then((next) => {
      setState(next);
      setIncident(next.incident);
    }).catch(() => undefined);
    void refresh();
    const poll = setInterval(refresh, 2000);

    const socket = io();
    socket.on("app-log", (entry: AppLog) => push(line(entry.source, entry.line, toneFor(entry), entry.at)));
    socket.on("app-incident", (next: AppIncident | null) => {
      setIncident(next);
      // Show the code as it is now after an injection or a rollback.
      if (next && ["detected", "resolved"].includes(next.phase) && selectedRef.current) loadFile(selectedRef.current);
    });
    return () => {
      clearInterval(poll);
      socket.disconnect();
    };
  }, [loadFile, push, showFiles]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [lines]);

  const tree = useMemo(() => buildTree(files ?? []), [files]);

  const toggle = (path: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const onUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = [...(event.target.files ?? [])];
    event.target.value = "";
    if (picked.length === 0) return;
    const usable = picked
      .map((file) => ({ file, path: file.webkitRelativePath.split("/").slice(1).join("/") || file.name }))
      .filter(({ file, path }) => !SKIP_DIRS.test(`${path}`) && file.size <= MAX_UPLOAD_BYTES && TEXT_FILE.test(path));
    try {
      setUploading(`0 / ${usable.length}`);
      await api.app.reset();
      setSelected(null);
      setContent(null);
      for (const [index, { file, path }] of usable.entries()) {
        await api.app.upload(path, await file.text());
        setUploading(`${index + 1} / ${usable.length}`);
      }
      showFiles(await api.app.uploaded());
      say(`uploaded ${usable.length} files (skipped ${picked.length - usable.length}: node_modules, binaries, large files)`, "ok");
      say("next: run npm install if it has dependencies, then npm start", "muted");
    } catch (error) {
      say(`upload failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setUploading(null);
    }
  };

  const inject = async () => {
    setInjecting(true);
    try {
      const result = await api.app.inject();
      if (result) loadFile(result.file);
    } catch (error) {
      say(`inject failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setInjecting(false);
    }
  };

  const run = async (raw: string) => {
    const command = raw.trim();
    if (!command) return;
    push(line("$", command, "cmd"));
    const [name, ...args] = command.split(/\s+/);
    switch (name.toLowerCase()) {
      case "help":
        HELP.forEach((entry) => say(entry, "muted"));
        return;
      case "cls":
      case "clear":
        setLines([]);
        return;
      case "inject":
        await inject();
        return;
      case "stop":
        await api.app.stop();
        return;
      case "status": {
        if (!state) return say("no state yet", "muted");
        const health = state.health;
        say(
          `${state.running ? `running \`${state.command}\` (pid ${state.pid})` : "not running"} · ${health.requests} req in 4s · errors ${percent(health.errorRate)} · p95 ${health.p95Ms} ms`,
          state.running && health.errorRate < 0.05 ? "ok" : "warn",
        );
        say(`routes under watch: ${state.routes.join(", ")}`, "muted");
        return;
      }
      case "open": {
        const match = (files ?? []).find((file) => file.path === args[0] || file.path.endsWith(`/${args[0]}`));
        if (!match) return say(`no file matches ${args[0] ?? "''"}`, "error");
        loadFile(match.path);
        return;
      }
      default:
        try {
          await api.app.exec(command);
        } catch (error) {
          say(`command failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
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

  const health = state?.health;
  const empty = files !== null && files.length === 0;
  const live = incident && incident.phase !== "resolved" && incident.phase !== "escalated";

  return (
    <div className="grid h-[calc(100vh-10.5rem)] min-h-[560px] gap-3 lg:grid-cols-[230px_minmax(0,1fr)_300px]">
      {/* Explorer */}
      <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-[#1b1b1f]">
        <header className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">Explorer · my app</span>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => folderRef.current?.click()} disabled={uploading !== null}>
            {uploading ? <Loader2 className="animate-spin" /> : <FolderUp />}
            {uploading ?? "Upload"}
          </Button>
          <input ref={folderRef} type="file" multiple className="hidden" onChange={(event) => void onUpload(event)} {...{ webkitdirectory: "" }} />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {files === null ? (
            Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="mx-3 my-1.5 h-4" />)
          ) : empty ? (
            <button
              onClick={() => folderRef.current?.click()}
              className="m-3 flex w-[calc(100%-1.5rem)] flex-col items-center gap-2 rounded-lg border border-dashed border-white/15 px-3 py-8 text-center text-xs text-zinc-400 hover:border-indigo-400/50 hover:text-zinc-200"
            >
              <FolderUp className="size-6 text-indigo-300" />
              Upload your Node/Express project folder
              <span className="text-zinc-500">node_modules is skipped</span>
            </button>
          ) : (
            [...tree.children.values()].map((node) => (
              <TreeItem key={node.path} node={node} depth={0} selected={selected ?? ""} open={open} onToggle={toggle} onOpen={loadFile} />
            ))
          )}
        </div>
      </section>

      {/* Editor + terminal */}
      <section className="flex min-h-0 flex-col gap-3">
        <div className="flex min-h-0 flex-[3] flex-col overflow-hidden rounded-xl border border-white/10 bg-[#1e1e1e]">
          <header className="flex items-center justify-between border-b border-white/10 bg-[#252526] px-3 py-1.5">
            <span className="flex items-center gap-1.5 font-mono text-xs text-zinc-200">
              <FileCode2 className="size-3.5 text-sky-400" />
              {selected ?? "no file open"}
            </span>
            {incident?.injection?.file === selected && live && <Badge variant="destructive">bug injected here</Badge>}
          </header>
          <div className="min-h-0 flex-1">
            {selected === null ? (
              <p className="p-6 text-sm text-zinc-500">Upload a project to see its code here.</p>
            ) : (
              <Suspense fallback={<Skeleton className="m-4 h-40" />}>
                {content === null ? <Skeleton className="m-4 h-40" /> : <CodeEditor path={`app/${selected}`} content={content} />}
              </Suspense>
            )}
          </div>
        </div>

        <div
          className="flex min-h-0 flex-[2] flex-col overflow-hidden rounded-xl border border-white/10 bg-[#0d0d10]"
          onClick={() => inputRef.current?.focus()}
        >
          <header className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5 text-xs text-zinc-300">
            <SquareTerminal className="size-3.5 text-emerald-400" />
            Terminal
            <span className="text-zinc-500">· runs in your app folder (type help)</span>
          </header>
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[12.5px] leading-relaxed">
            {lines.length === 0 && <p className="text-zinc-500">Upload a project, then try npm start.</p>}
            {lines.map((entry) => (
              <div key={entry.id} className="flex gap-2 whitespace-pre-wrap break-words">
                <span className="shrink-0 text-zinc-600">{entry.at.slice(11, 19)}</span>
                <span className={cn("shrink-0", TAG_COLOR[entry.tag] ?? "text-zinc-400")}>{entry.tag === "$" ? "$" : `[${entry.tag}]`}</span>
                <span className={TONE_COLOR[entry.tone]}>{entry.text}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 border-t border-white/10 px-3 py-2 font-mono text-[13px]">
            <span className="text-emerald-400">app $</span>
            <input
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKey}
              spellCheck={false}
              autoComplete="off"
              placeholder="npm start"
              className="min-w-0 flex-1 bg-transparent text-zinc-50 outline-none placeholder:text-zinc-600"
              aria-label="App terminal command"
            />
          </div>
        </div>
      </section>

      {/* Live app + NightShift */}
      <section className="flex min-h-0 flex-col gap-3 overflow-y-auto">
        <div className="rounded-xl border bg-card p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Your app</p>
            {state?.running ? (
              <Badge variant={health && health.errorRate >= 0.15 ? "destructive" : "success"}>
                <StatusDot className={health && health.errorRate >= 0.15 ? "bg-rose-500" : "bg-emerald-400"} pulse />
                {health && health.errorRate >= 0.15 ? "Failing" : "Running"}
              </Badge>
            ) : (
              <Badge variant="muted">Stopped</Badge>
            )}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">{state?.command ?? "no server command yet"}</p>
          <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
            {[
              ["req / 4s", health ? String(health.requests) : "-"],
              ["errors", health ? percent(health.errorRate) : "-"],
              ["p95", health ? `${health.p95Ms} ms` : "-"],
            ].map(([label, value]) => (
              <div key={label} className="rounded-md border bg-background/40 px-1 py-1.5">
                <dd className="font-mono text-sm">{value}</dd>
                <dt className="text-[10px] text-muted-foreground">{label}</dt>
              </div>
            ))}
          </dl>
          <div className="mt-3 flex gap-2">
            {state?.running ? (
              <Button size="sm" variant="outline" className="flex-1" onClick={() => void api.app.stop()}>
                <Square />
                Stop
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="flex-1" disabled={empty || files === null} onClick={() => void run("npm start")}>
                <Play />
                npm start
              </Button>
            )}
            <Button size="sm" className="flex-1" disabled={!state?.running || injecting || Boolean(live)} onClick={() => void inject()}>
              {injecting ? <Loader2 className="animate-spin" /> : <Bug />}
              AI: inject bug
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Traffic runs through NightShift's proxy on :{state?.proxyPort ?? 4500}, so your app needs no changes.
          </p>
        </div>

        <div className="rounded-xl border bg-card p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">NightShift</p>
            {incident && <Badge variant={PHASE_META[incident.phase].variant}>{PHASE_META[incident.phase].label}</Badge>}
          </div>
          {!incident ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <StatusDot className="bg-emerald-400" pulse />
              {state?.running ? "On watch." : "Waiting for your app to start."}
            </p>
          ) : (
            <div className="space-y-2.5 text-sm">
              {incident.injection && (
                <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-xs text-rose-200">
                  <ShieldAlert className="mr-1 inline size-3.5" />
                  {incident.injection.injectedBy} changed <span className="font-mono">{incident.injection.file}</span>: {incident.injection.description}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Trigger: {incident.trigger.reachable ? `${percent(incident.trigger.errorRate)} errors` : "app unreachable"}
                {incident.changedFiles.length > 0 && <> · changed: {incident.changedFiles.join(", ")}</>}
              </p>
              {incident.candidates.length > 0 && (
                <ul className="space-y-1.5">
                  {incident.candidates.map((candidate) => (
                    <li key={candidate.id} className="flex items-start gap-2 text-xs">
                      {candidate.verdict === "promote" ? (
                        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />
                      ) : (
                        <XCircle className="mt-0.5 size-3.5 shrink-0 text-rose-400" />
                      )}
                      <span>
                        <span className="font-medium">{candidate.label}</span>
                        <span className="text-muted-foreground">
                          {" "}
                          · shadow test {percent(candidate.errorRate)} errors / {candidate.requests} req
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {live && incident.phase === "verifying" && (
                <p className="flex items-center gap-1.5 text-xs text-amber-200">
                  <Loader2 className="size-3.5 animate-spin" />
                  Replaying production requests on shadow copies…
                </p>
              )}
              {incident.receipt && (
                <div className="rounded-md border bg-background/40 p-2">
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Heal Receipt</p>
                  <p className="whitespace-pre-wrap text-xs leading-relaxed">{incident.receipt}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
