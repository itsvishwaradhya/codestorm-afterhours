import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { io } from "socket.io-client";
import {
  Bug,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  CircleDot,
  Copy,
  Download,
  ExternalLink,
  File,
  FileCode2,
  FileJson,
  FilePlus2,
  FileText,
  Files,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderUp,
  FolderX,
  GitCompare,
  Loader2,
  Pencil,
  Play,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Square,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { api, type AppIncident, type AppLog, type AppResponse, type AppState, type HttpMethod, type WorkspaceFile } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { percent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { languageOf } from "./code-editor";
import { RequestPanel, type AppRequest } from "./request-panel";
import { StatusDot } from "./status";
import { TAG_COLOR, TONE_COLOR, line, type TermLine, type Tone } from "./workspace";
import { SearchPanel } from "./workspace-search";

const CodeEditor = lazy(() => import("./code-editor"));
const CodeDiff = lazy(() => import("./code-editor").then((module) => ({ default: module.CodeDiff })));
const XtermPanel = lazy(() => import("./xterm-panel"));

const SESSION_KEY = "nightshift.workspace.session";
const LAYOUT_KEY = "nightshift.workspace.layout";

interface Session {
  open: string[];
  active: string | null;
  drafts: Record<string, string>;
}

function readStored<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the workspace still works, it just won't remember.
  }
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

// Pointer drag for the splitters; reports the distance moved since the press.
function startDrag(event: ReactPointerEvent, cursor: string, onMove: (dx: number, dy: number) => void, onEnd: () => void) {
  event.preventDefault();
  const x = event.clientX;
  const y = event.clientY;
  const move = (next: PointerEvent) => onMove(next.clientX - x, next.clientY - y);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    onEnd();
  };
  document.body.style.cursor = cursor;
  document.body.style.userSelect = "none";
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

const DIFF_PREFIX = "diff:";
const diffTarget = (path: string) => path.slice(DIFF_PREFIX.length);

const MAX_OUTPUT = 600;
const MAX_UPLOAD_BYTES = 200 * 1024;
const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|build|coverage)\//;
const TEXT_FILE = /\.(c|m)?(j|t)sx?$|\.(json|md|txt|env\.example|html|css|scss|ya?ml|sh)$|(^|\/)[^.]+$/;
const ENTRY_FILES = ["server.js", "index.js", "app.js", "src/server.js", "src/index.js", "src/app.js"];

const PHASE_META: Record<AppIncident["phase"], { label: string; variant: "destructive" | "warning" | "success" | "default" }> = {
  detected: { label: "Detected", variant: "destructive" },
  verifying: { label: "Shadow testing", variant: "warning" },
  promoting: { label: "Applying fix", variant: "warning" },
  watching: { label: "Watching", variant: "default" },
  resolved: { label: "Resolved", variant: "success" },
  escalated: { label: "Escalated", variant: "destructive" },
};

interface Tab {
  path: string;
  content: string;
  saved: string;
  // Set on diff tabs (path "diff:<file>"): the last known good version shown on the left.
  original?: string;
}

interface Node {
  name: string;
  path: string;
  dir: boolean;
  children: Node[];
}

type Pending =
  | { kind: "file" | "folder"; parent: string; value: string }
  | { kind: "rename"; parent: string; path: string; value: string };

interface Menu {
  x: number;
  y: number;
  node: Node | null;
}

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const nameOf = (path: string) => path.split("/").pop() ?? path;
const join = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);

function buildTree(entries: WorkspaceFile[]): Node {
  const root: Node = { name: "", path: "", dir: true, children: [] };
  const index = new Map<string, Node>([["", root]]);
  const ensureDir = (path: string): Node => {
    const existing = index.get(path);
    if (existing) return existing;
    const node: Node = { name: nameOf(path), path, dir: true, children: [] };
    index.set(path, node);
    ensureDir(parentOf(path)).children.push(node);
    return node;
  };
  for (const entry of entries) {
    if (entry.dir) ensureDir(entry.path);
    else ensureDir(parentOf(entry.path)).children.push({ name: nameOf(entry.path), path: entry.path, dir: false, children: [] });
  }
  const sort = (node: Node) => {
    node.children.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}

function FileIcon({ path, className }: { path: string; className?: string }) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "json") return <FileJson className={cn("text-amber-300", className)} />;
  if (["js", "mjs", "cjs", "jsx"].includes(ext)) return <FileCode2 className={cn("text-yellow-300", className)} />;
  if (["ts", "tsx"].includes(ext)) return <FileCode2 className={cn("text-sky-400", className)} />;
  if (["md", "txt"].includes(ext)) return <FileText className={cn("text-sky-200", className)} />;
  return <File className={cn("text-zinc-400", className)} />;
}

function toneFor(entry: AppLog): Tone {
  if (entry.stream === "stderr") return "error";
  if (entry.source === "nightshift") return entry.stream === "stdout" ? "ok" : "info";
  return "muted";
}

function NameInput({ initial, onSubmit, onCancel, depth, icon }: {
  initial: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  depth: number;
  icon: "file" | "folder";
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const onKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Enter" && value.trim()) onSubmit(value.trim());
    if (event.key === "Escape") onCancel();
  };
  return (
    <div className="flex items-center gap-1.5 py-0.5 pr-2" style={{ paddingLeft: 8 + depth * 12 + 14 }}>
      {icon === "folder" ? <Folder className="size-3.5 shrink-0 text-amber-300" /> : <File className="size-3.5 shrink-0 text-zinc-400" />}
      <input
        ref={ref}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKey}
        onBlur={() => (value.trim() && value.trim() !== initial ? onSubmit(value.trim()) : onCancel())}
        className="min-w-0 flex-1 border border-[#007fd4] bg-[#3c3c3c] px-1 text-[13px] text-zinc-100 outline-none"
        spellCheck={false}
      />
    </div>
  );
}

export function AppWorkspace() {
  const [entries, setEntries] = useState<WorkspaceFile[] | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [selected, setSelected] = useState<Node | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<Pending | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [incident, setIncident] = useState<AppIncident | null>(null);
  const [output, setOutput] = useState<TermLine[]>([]);
  const [panel, setPanel] = useState<"terminal" | "output" | "requests">("terminal");
  const [panelOpen, setPanelOpen] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarView, setSidebarView] = useState<"explorer" | "search">("explorer");
  const [searchSignal, setSearchSignal] = useState(0);
  const [reveal, setReveal] = useState<{ path: string; line: number; column: number } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [layout, setLayout] = useState(() => readStored<{ sidebar: number; panel: number | null }>(LAYOUT_KEY) ?? { sidebar: 240, panel: null });
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [request, setRequest] = useState<AppRequest>({ method: "GET", path: "/", body: "" });
  const [response, setResponse] = useState<(AppResponse & { method: HttpMethod; path: string }) | null>(null);
  const [sending, setSending] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const restoredRef = useRef(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [uploading, setUploading] = useState<string | null>(null);
  const [injecting, setInjecting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<Tab[]>([]);
  tabsRef.current = tabs;
  const epochRef = useRef(0);

  const files = useMemo(() => (entries ?? []).filter((entry) => !entry.dir), [entries]);
  const tree = useMemo(() => buildTree(entries ?? []), [entries]);
  const activeTab = tabs.find((tab) => tab.path === active) ?? null;
  const activeDiff = activeTab && activeTab.original !== undefined ? diffTarget(activeTab.path) : null;

  const say = useCallback((text: string, tone: Tone = "info") => {
    setOutput((current) => [...current, line("nightshift", text, tone)].slice(-MAX_OUTPUT));
  }, []);

  const flash = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((current) => (current === text ? null : current)), 3000);
  }, []);

  const openFile = useCallback(async (path: string, at?: { line: number; column: number }) => {
    setActive(path);
    setReveal(at ? { path, ...at } : null);
    if (tabsRef.current.some((tab) => tab.path === path)) return;
    // A load that started before a new folder was opened must not bring the old file back.
    const started = epochRef.current;
    const file = await api.app.file(path).catch(() => ({ path, content: "" }));
    if (epochRef.current !== started) return;
    setTabs((current) =>
      current.some((tab) => tab.path === path) ? current : [...current, { path, content: file.content, saved: file.content }],
    );
  }, []);

  // Pick up changes made on disk by NightShift (injection, rollback) in tabs with no unsaved edits.
  const reloadClean = useCallback(async () => {
    for (const tab of tabsRef.current) {
      if (tab.original !== undefined) {
        const file = diffTarget(tab.path);
        const [good, current] = await Promise.all([api.app.goodFile(file).catch(() => null), api.app.file(file).catch(() => null)]);
        const original = good?.content ?? tab.original;
        const content = current?.content ?? tab.content;
        if (original !== tab.original || content !== tab.content) {
          setTabs((list) => list.map((item) => (item.path === tab.path ? { ...item, original, content, saved: content } : item)));
        }
        continue;
      }
      if (tab.content !== tab.saved) continue;
      const file = await api.app.file(tab.path).catch(() => null);
      if (file && file.content !== tab.saved) {
        setTabs((current) => current.map((item) => (item.path === tab.path ? { ...item, content: file.content, saved: file.content } : item)));
      }
    }
  }, []);

  const showTree = useCallback(
    (list: WorkspaceFile[], openEntry = false) => {
      setEntries(list);
      if (openEntry) {
        setExpanded(new Set(list.filter((entry) => entry.dir).map((entry) => entry.path)));
        const firstFiles = list.filter((entry) => !entry.dir);
        const entry =
          ENTRY_FILES.find((name) => firstFiles.some((file) => file.path === name)) ??
          firstFiles.find((file) => /\.(c|m)?js$/.test(file.path))?.path ??
          firstFiles[0]?.path;
        if (entry) void openFile(entry);
      }
    },
    [openFile],
  );

  const refreshTree = useCallback(() => api.app.tree().then((list) => showTree(list)).catch(() => setEntries([])), [showTree]);

  // Reopens the tabs (and unsaved drafts) from before a page reload.
  const restoreSession = useCallback(
    async (list: WorkspaceFile[]) => {
      const session = readStored<Session>(SESSION_KEY);
      const exists = new Set(list.filter((entry) => !entry.dir).map((entry) => entry.path));
      const open = (session?.open ?? []).filter((path) => exists.has(path));
      if (open.length === 0) {
        showTree(list, true);
        restoredRef.current = true;
        return;
      }
      showTree(list);
      setExpanded(new Set(list.filter((entry) => entry.dir).map((entry) => entry.path)));
      for (const path of open) await openFile(path);
      const drafts = session?.drafts ?? {};
      setTabs((current) => current.map((tab) => (drafts[tab.path] !== undefined ? { ...tab, content: drafts[tab.path] } : tab)));
      setActive(session?.active && open.includes(session.active) ? session.active : open[open.length - 1]);
      restoredRef.current = true;
    },
    [openFile, showTree],
  );

  useEffect(() => {
    if (!restoredRef.current) return;
    const plain = tabs.filter((tab) => tab.original === undefined);
    writeStored(SESSION_KEY, {
      open: plain.map((tab) => tab.path),
      active: active && !active.startsWith(DIFF_PREFIX) ? active : null,
      drafts: Object.fromEntries(plain.filter((tab) => tab.content !== tab.saved).map((tab) => [tab.path, tab.content])),
    } satisfies Session);
  }, [tabs, active]);

  useEffect(() => {
    if (!tabs.some((tab) => tab.content !== tab.saved)) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [tabs]);

  useEffect(() => {
    api.app
      .tree()
      .then((list) => restoreSession(list))
      .catch(() => {
        setEntries([]);
        restoredRef.current = true;
      });
    const refresh = () =>
      api.app
        .state()
        .then((next) => {
          setState(next);
          setIncident(next.incident);
        })
        .catch(() => undefined);
    void refresh();
    const poll = setInterval(refresh, 2000);

    const socket = io();
    socket.on("app-log", (entry: AppLog) =>
      setOutput((current) => [...current, line(entry.source, entry.line, toneFor(entry), entry.at)].slice(-MAX_OUTPUT)),
    );
    socket.on("app-incident", (next: AppIncident | null) => {
      setIncident(next);
      if (next && ["detected", "watching", "resolved"].includes(next.phase)) void reloadClean();
    });
    // Files changed on disk (terminal, npm install, injection, rollback).
    socket.on("app-tree", () => {
      void refreshTree();
      void reloadClean();
    });
    return () => {
      clearInterval(poll);
      socket.disconnect();
    };
  }, [reloadClean, refreshTree, restoreSession]);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [output, panel]);

  // ---- editor actions --------------------------------------------------------------------
  const save = useCallback(
    async (path = active) => {
      const tab = tabsRef.current.find((item) => item.path === path);
      if (!tab || tab.original !== undefined) return;
      try {
        await api.app.save(tab.path, tab.content);
        setTabs((current) => current.map((item) => (item.path === tab.path ? { ...item, saved: tab.content } : item)));
        flash(`Saved ${tab.path}`);
        if (state?.running) say(`${tab.path} saved. Restart the app in the terminal (Ctrl+C, then ↑ Enter) to run the change.`, "muted");
      } catch (error) {
        flash(`Could not save ${tab.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [active, flash, say, state?.running],
  );

  const closeTabs = (paths: string[]) => {
    const closing = tabs.filter((item) => paths.includes(item.path));
    const dirty = closing.filter((item) => item.content !== item.saved);
    if (dirty.length === 1 && !window.confirm(`Discard unsaved changes to ${nameOf(dirty[0].path)}?`)) return;
    if (dirty.length > 1 && !window.confirm(`Discard unsaved changes in ${dirty.length} files?`)) return;
    const index = tabs.findIndex((item) => item.path === active);
    const next = tabs.filter((item) => !paths.includes(item.path));
    setTabs(next);
    if (active && paths.includes(active)) setActive(next[Math.min(index, next.length - 1)]?.path ?? null);
  };

  const closeTab = (path: string, event?: ReactMouseEvent) => {
    event?.stopPropagation();
    closeTabs([path]);
  };

  // Last known good (left) against the file as it is now (right).
  const openDiff = async (file: string) => {
    setMenu(null);
    const [good, current] = await Promise.all([api.app.goodFile(file).catch(() => null), api.app.file(file).catch(() => null)]);
    if (!good) {
      flash(`No last known good copy of ${file} yet. NightShift saves one after the app serves cleanly for 10 s.`);
      return;
    }
    const path = DIFF_PREFIX + file;
    const content = current?.content ?? "";
    const tab: Tab = { path, content, saved: content, original: good.content };
    setTabs((list) => (list.some((item) => item.path === path) ? list.map((item) => (item.path === path ? tab : item)) : [...list, tab]));
    setActive(path);
  };

  const send = async (next?: AppRequest) => {
    const current = next ?? request;
    if (next) setRequest(next);
    setSending(true);
    setPanel("requests");
    setPanelOpen(true);
    try {
      const result = await api.app.request(current.method, current.path, current.body);
      setResponse({ ...result, method: current.method, path: current.path });
    } catch (error) {
      const body = error instanceof Error ? error.message : String(error);
      setResponse({ status: 0, ms: 0, contentType: null, body, method: current.method, path: current.path });
    } finally {
      setSending(false);
    }
  };

  const download = () => {
    setMenu(null);
    const link = document.createElement("a");
    link.href = api.app.downloadUrl;
    link.download = "my-app.zip";
    link.click();
  };

  const dragSidebar = (event: ReactPointerEvent) => {
    const start = layoutRef.current.sidebar;
    startDrag(
      event,
      "col-resize",
      (dx) => setLayout((current) => ({ ...current, sidebar: clamp(start + dx, 180, 480) })),
      () => writeStored(LAYOUT_KEY, layoutRef.current),
    );
  };

  const dragPanel = (event: ReactPointerEvent) => {
    const start = panelRef.current?.offsetHeight ?? 240;
    const max = (columnRef.current?.clientHeight ?? 600) * 0.75;
    startDrag(
      event,
      "row-resize",
      (_dx, dy) => setLayout((current) => ({ ...current, panel: clamp(start - dy, 100, max) })),
      () => writeStored(LAYOUT_KEY, layoutRef.current),
    );
  };

  // ---- explorer actions ------------------------------------------------------------------
  const targetFolder = (node: Node | null) => (node ? (node.dir ? node.path : parentOf(node.path)) : "");

  const startCreate = (kind: "file" | "folder", node: Node | null = selected) => {
    const parent = targetFolder(node);
    if (parent) setExpanded((current) => new Set(current).add(parent));
    setPending({ kind, parent, value: "" });
    setMenu(null);
  };

  const commitPending = async (value: string) => {
    const current = pending;
    setPending(null);
    if (!current || value.includes("..")) return;
    try {
      if (current.kind === "folder") {
        showTree(await api.app.mkdir(join(current.parent, value)));
      } else if (current.kind === "file") {
        const path = join(current.parent, value);
        await api.app.save(path, "");
        await refreshTree();
        void openFile(path);
      } else if (current.kind === "rename") {
        const from = current.path;
        const to = join(current.parent, value);
        const moved = (path: string) => path === from || path.startsWith(`${from}/`);
        showTree(await api.app.rename(from, to));
        setTabs((list) => list.map((tab) => (moved(tab.path) ? { ...tab, path: to + tab.path.slice(from.length) } : tab)));
        setActive((path) => (path && moved(path) ? to + path.slice(from.length) : path));
      }
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error));
    }
  };

  const remove = async (node: Node) => {
    setMenu(null);
    const what = node.dir ? `the folder '${node.name}' and its contents` : `'${node.name}'`;
    if (!window.confirm(`Are you sure you want to delete ${what}?`)) return;
    showTree(await api.app.remove(node.path));
    const gone = (path: string) => path === node.path || path.startsWith(`${node.path}/`);
    const remaining = tabs.filter((tab) => !gone(tab.path));
    setTabs(remaining);
    setActive((path) => (path && gone(path) ? (remaining[remaining.length - 1]?.path ?? null) : path));
    if (selected?.path === node.path) setSelected(null);
  };

  // VS Code's "Close Folder": stops the app and empties the workspace back to "Open Folder".
  const closeFolder = async () => {
    setMenu(null);
    if (tabs.some((tab) => tab.content !== tab.saved) && !window.confirm("Discard unsaved changes in open editors?")) return;
    if (!window.confirm(`Close folder '${projectName}'? This stops the app and removes its files from the workspace.`)) return;
    try {
      epochRef.current += 1;
      await api.app.reset();
      showTree(await api.app.uploaded());
      setTabs([]);
      setActive(null);
      setSelected(null);
      setPending(null);
      setExpanded(new Set());
      say("closed folder", "muted");
      flash("Folder closed");
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error));
    }
  };

  const toggle = (path: string) =>
    setExpanded((current) => {
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
      .filter(({ file, path }) => !SKIP_DIRS.test(path) && file.size <= MAX_UPLOAD_BYTES && TEXT_FILE.test(path));
    try {
      setUploading(`0/${usable.length}`);
      epochRef.current += 1;
      await api.app.reset();
      setTabs([]);
      setActive(null);
      setSelected(null);
      for (const [index, { file, path }] of usable.entries()) {
        await api.app.upload(path, await file.text());
        setUploading(`${index + 1}/${usable.length}`);
      }
      showTree(await api.app.uploaded(), true);
      say(`uploaded ${usable.length} files (skipped ${picked.length - usable.length}: node_modules, binaries, large files)`, "ok");
      flash(`Opened ${usable.length} files. Run npm install / npm start in the terminal.`);
      setPanel("terminal");
      setPanelOpen(true);
    } catch (error) {
      say(`upload failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setUploading(null);
    }
  };

  const inject = async () => {
    setInjecting(true);
    setPanel("output");
    setPanelOpen(true);
    try {
      const result = await api.app.inject();
      if (result) {
        await reloadClean();
        void openFile(result.file);
      }
    } catch (error) {
      say(`inject failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setInjecting(false);
    }
  };

  // ---- keyboard shortcuts ----------------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      // Browsers keep Ctrl+W for themselves, so closing a tab is Alt+W here.
      if (event.altKey && !mod && (key === "w" || event.code === "KeyW")) {
        event.preventDefault();
        if (active) closeTab(active);
        return;
      }
      if (!mod) return;
      if (key === "f" && event.shiftKey) {
        event.preventDefault();
        setSidebarOpen(true);
        setSidebarView("search");
        setSearchSignal((count) => count + 1);
      } else if (key === "e" && event.shiftKey) {
        event.preventDefault();
        setSidebarOpen(true);
        setSidebarView("explorer");
      } else if (key === "p" && !event.shiftKey) {
        event.preventDefault();
        setQuery("");
        setQuickOpen(true);
      } else if (key === "s") {
        event.preventDefault();
        void save();
      } else if (key === "`" || event.code === "Backquote") {
        event.preventDefault();
        setPanel("terminal");
        setPanelOpen((open) => !open || panel !== "terminal");
      } else if (key === "b") {
        event.preventDefault();
        setSidebarOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!menu && !tabMenu) return;
    const close = () => {
      setMenu(null);
      setTabMenu(null);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu, tabMenu]);

  const searchOverlay = useMemo(
    () => new Map(tabs.filter((tab) => tab.original === undefined).map((tab) => [tab.path, tab.content])),
    [tabs],
  );

  const matches = useMemo(() => {
    const needle = query.toLowerCase();
    const scored = files
      .map((file) => {
        const name = nameOf(file.path).toLowerCase();
        const at = name.indexOf(needle);
        const inPath = file.path.toLowerCase().indexOf(needle);
        return { file, score: needle === "" ? 0 : at === 0 ? 0 : at > 0 ? 1 : inPath >= 0 ? 2 : -1 };
      })
      .filter((item) => item.score >= 0)
      .sort((a, b) => a.score - b.score || a.file.path.localeCompare(b.file.path));
    return scored.slice(0, 12).map((item) => item.file);
  }, [files, query]);
  const [pick, setPick] = useState(0);
  useEffect(() => setPick(0), [query, quickOpen]);

  // ---- render helpers ----------------------------------------------------------------------
  const renderNode = (node: Node, depth: number): React.ReactNode => {
    const isRenaming = pending?.kind === "rename" && pending.path === node.path;
    const indent = { paddingLeft: 8 + depth * 12 };
    const onContext = (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setSelected(node);
      setMenu({ x: event.clientX, y: event.clientY, node });
    };
    const creatingHere = pending && pending.kind !== "rename" && pending.parent === node.path;

    if (isRenaming) {
      return (
        <NameInput
          key={node.path}
          initial={node.name}
          depth={depth - 1}
          icon={node.dir ? "folder" : "file"}
          onSubmit={(value) => void commitPending(value)}
          onCancel={() => setPending(null)}
        />
      );
    }

    if (!node.dir) {
      const tab = tabs.find((item) => item.path === node.path);
      return (
        <button
          key={node.path}
          onClick={() => {
            setSelected(node);
            void openFile(node.path);
          }}
          onContextMenu={onContext}
          style={{ paddingLeft: indent.paddingLeft + 14 }}
          className={cn(
            "flex w-full items-center gap-1.5 truncate py-[3px] pr-2 text-left text-[13px] hover:bg-[#2a2d2e]",
            active === node.path ? "bg-[#37373d] text-white" : "text-[#cccccc]",
            selected?.path === node.path && "outline outline-1 -outline-offset-1 outline-[#007fd4]",
          )}
        >
          <FileIcon path={node.path} className="size-3.5 shrink-0" />
          <span className={cn("truncate", live && incident?.changedFiles.includes(node.path) && "text-amber-300")}>{node.name}</span>
          {tab && tab.content !== tab.saved && <CircleDot className="ml-auto size-3 shrink-0 text-zinc-300" />}
          {live && incident?.injection?.file === node.path && (
            <span title="Bug injected here" className="ml-auto size-2 shrink-0 rounded-full bg-rose-500" />
          )}
        </button>
      );
    }

    const open = expanded.has(node.path);
    return (
      <div key={node.path}>
        <button
          onClick={() => {
            setSelected(node);
            toggle(node.path);
          }}
          onContextMenu={onContext}
          style={indent}
          className={cn(
            "flex w-full items-center gap-1 py-[3px] pr-2 text-left text-[13px] text-[#cccccc] hover:bg-[#2a2d2e]",
            selected?.path === node.path && "outline outline-1 -outline-offset-1 outline-[#007fd4]",
          )}
        >
          {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
          {open ? <FolderOpen className="size-3.5 shrink-0 text-amber-300" /> : <Folder className="size-3.5 shrink-0 text-amber-300" />}
          <span className="truncate">{node.name}</span>
        </button>
        {open && (
          <>
            {creatingHere && (
              <NameInput
                initial=""
                depth={depth + 1}
                icon={pending.kind === "folder" ? "folder" : "file"}
                onSubmit={(value) => void commitPending(value)}
                onCancel={() => setPending(null)}
              />
            )}
            {node.children.map((child) => renderNode(child, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const health = state?.health;
  const failing = Boolean(health && state?.running && health.errorRate >= 0.15);
  const live = incident && incident.phase !== "resolved" && incident.phase !== "escalated";
  const empty = entries !== null && entries.length === 0;
  const projectName = state?.command ? "my-app" : "my-app";

  return (
    <div className="relative flex h-[calc(100vh-10.5rem)] min-h-[560px] gap-3">
      {/* VS Code window */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-[#2b2b2b] bg-[#1f1f1f] text-[#cccccc]">
        <div className="flex min-h-0 flex-1">
          {/* Activity bar */}
          <div className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-[#2b2b2b] bg-[#181818] py-2">
            {[
              { id: "explorer" as const, title: "Explorer (Ctrl+Shift+E)", icon: Files },
              { id: "search" as const, title: "Search (Ctrl+Shift+F)", icon: Search },
            ].map((item) => {
              const on = sidebarOpen && sidebarView === item.id;
              return (
                <button
                  key={item.id}
                  title={item.title}
                  onClick={() => {
                    if (on) {
                      setSidebarOpen(false);
                    } else {
                      setSidebarOpen(true);
                      setSidebarView(item.id);
                      if (item.id === "search") setSearchSignal((count) => count + 1);
                    }
                  }}
                  className={cn("grid size-10 place-items-center border-l-2", on ? "border-white text-white" : "border-transparent text-zinc-500 hover:text-zinc-300")}
                >
                  <item.icon className="size-5" />
                </button>
              );
            })}
            <button title="Quick open (Ctrl+P)" onClick={() => setQuickOpen(true)} className="grid size-10 place-items-center border-l-2 border-transparent text-zinc-500 hover:text-zinc-300">
              <FileCode2 className="size-5" />
            </button>
          </div>

          {/* Explorer */}
          {sidebarOpen && (
            <aside className="relative flex shrink-0 flex-col border-r border-[#2b2b2b] bg-[#181818]" style={{ width: layout.sidebar }}>
              <div
                onPointerDown={dragSidebar}
                onDoubleClick={() => {
                  setLayout((current) => ({ ...current, sidebar: 240 }));
                  writeStored(LAYOUT_KEY, { ...layoutRef.current, sidebar: 240 });
                }}
                title="Drag to resize"
                className="absolute inset-y-0 -right-[3px] z-10 w-1.5 cursor-col-resize hover:bg-[#0078d4]/60"
              />
              <div className="flex h-9 items-center justify-between px-4 text-[11px] uppercase tracking-wide text-[#bbbbbb]">
                {sidebarView === "search" ? "Search" : "Explorer"}
              </div>
              {sidebarView === "search" && (
                <SearchPanel
                  files={files}
                  overlay={searchOverlay}
                  focusSignal={searchSignal}
                  onOpen={(path, lineNumber, column) => void openFile(path, { line: lineNumber, column })}
                />
              )}
              <div className={cn("flex min-h-0 flex-1 flex-col", sidebarView !== "explorer" && "hidden")}>
              <div
                className="group flex h-6 items-center justify-between pl-1 pr-1 text-[11px] font-bold uppercase text-[#cccccc]"
                onContextMenu={(event) => {
                  event.preventDefault();
                  setSelected(null);
                  setMenu({ x: event.clientX, y: event.clientY, node: null });
                }}
              >
                <span className="flex items-center gap-0.5">
                  <ChevronDown className="size-3.5" />
                  {projectName}
                </span>
                <span className="flex items-center gap-0.5 opacity-80">
                  {[
                    { title: "New File...", icon: FilePlus2, run: () => startCreate("file") },
                    { title: "New Folder...", icon: FolderPlus, run: () => startCreate("folder") },
                    { title: "Refresh Explorer", icon: RefreshCw, run: () => void refreshTree() },
                    { title: "Collapse Folders in Explorer", icon: ChevronsDownUp, run: () => setExpanded(new Set()) },
                    { title: "Open Folder (upload)", icon: FolderUp, run: () => folderRef.current?.click() },
                    ...(empty
                      ? []
                      : [
                          { title: "Download Folder (.zip)", icon: Download, run: download },
                          { title: "Close Folder", icon: FolderX, run: () => void closeFolder() },
                        ]),
                  ].map((action) => (
                    <button key={action.title} title={action.title} onClick={action.run} className="grid size-5 place-items-center rounded hover:bg-[#3c3c3c]">
                      <action.icon className="size-3.5" />
                    </button>
                  ))}
                </span>
              </div>
              <input ref={folderRef} type="file" multiple className="hidden" onChange={(event) => void onUpload(event)} {...{ webkitdirectory: "" }} />
              <div
                className="min-h-0 flex-1 overflow-y-auto pb-6"
                onContextMenu={(event) => {
                  event.preventDefault();
                  setSelected(null);
                  setMenu({ x: event.clientX, y: event.clientY, node: null });
                }}
                onClick={(event) => {
                  if (event.target === event.currentTarget) setSelected(null);
                }}
              >
                {uploading && (
                  <p className="flex items-center gap-2 px-4 py-2 text-xs text-zinc-400">
                    <Loader2 className="size-3.5 animate-spin" />
                    Uploading {uploading}
                  </p>
                )}
                {entries === null ? (
                  Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="mx-4 my-1.5 h-3.5 bg-zinc-700/40" />)
                ) : empty && !pending ? (
                  <div className="space-y-3 px-4 py-3 text-[13px] text-[#cccccc]">
                    <p>You have not yet opened a folder.</p>
                    <button onClick={() => folderRef.current?.click()} className="w-full rounded-sm bg-[#0078d4] py-1.5 text-white hover:bg-[#026ec1]">
                      Open Folder
                    </button>
                    <p className="text-xs text-zinc-500">Pick a Node/Express project. node_modules is skipped.</p>
                  </div>
                ) : (
                  <>
                    {pending && pending.kind !== "rename" && pending.parent === "" && (
                      <NameInput
                        initial=""
                        depth={0}
                        icon={pending.kind === "folder" ? "folder" : "file"}
                        onSubmit={(value) => void commitPending(value)}
                        onCancel={() => setPending(null)}
                      />
                    )}
                    {tree.children.map((child) => renderNode(child, 0))}
                  </>
                )}
              </div>
              </div>
            </aside>
          )}

          {/* Editor group + panel */}
          <div ref={columnRef} className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex h-9 shrink-0 overflow-x-auto bg-[#181818]">
                {tabs.map((tab) => {
                  const dirty = tab.content !== tab.saved;
                  const isActive = tab.path === active;
                  const isDiff = tab.original !== undefined;
                  return (
                    <div
                      key={tab.path}
                      onClick={() => {
                        setActive(tab.path);
                        setReveal(null);
                      }}
                      onAuxClick={(event) => event.button === 1 && closeTab(tab.path)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setMenu(null);
                        setTabMenu({ x: event.clientX, y: event.clientY, path: tab.path });
                      }}
                      title={isDiff ? `${diffTarget(tab.path)}: last known good ↔ current` : tab.path}
                      className={cn(
                        "group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-[#2b2b2b] pl-3 pr-1.5 text-[13px]",
                        isActive ? "border-t border-t-[#0078d4] bg-[#1f1f1f] text-white" : "bg-[#181818] text-[#9d9d9d] hover:text-[#cccccc]",
                      )}
                    >
                      {isDiff ? <GitCompare className="size-3.5 text-sky-300" /> : <FileIcon path={tab.path} className="size-3.5" />}
                      {isDiff ? `${nameOf(diffTarget(tab.path))} (good ↔ now)` : nameOf(tab.path)}
                      <button
                        onClick={(event) => closeTab(tab.path, event)}
                        className="grid size-5 place-items-center rounded hover:bg-[#3c3c3c]"
                        title="Close"
                      >
                        {dirty ? (
                          <>
                            <span className="size-2 rounded-full bg-[#cccccc] group-hover:hidden" />
                            <X className="hidden size-3.5 group-hover:block" />
                          </>
                        ) : (
                          <X className={cn("size-3.5", isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100")} />
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
              {activeTab && activeDiff !== null && (
                <div className="flex h-6 shrink-0 items-center gap-2 px-3 text-xs text-[#a9a9a9]">
                  <GitCompare className="size-3 text-sky-300" />
                  <span>{activeDiff}</span>
                  <span className="text-zinc-500">last known good (left) ↔ current file (right)</span>
                  <button onClick={() => void openFile(activeDiff)} className="ml-auto rounded px-1.5 hover:bg-[#3c3c3c]">
                    Open file
                  </button>
                </div>
              )}
              {activeTab && activeDiff === null && (
                <div className="flex h-6 shrink-0 items-center gap-1 px-3 text-xs text-[#a9a9a9]">
                  {activeTab.path.split("/").map((part, index, parts) => (
                    <span key={index} className="flex items-center gap-1">
                      {index > 0 && <ChevronRight className="size-3" />}
                      {index === parts.length - 1 && <FileIcon path={activeTab.path} className="size-3" />}
                      {part}
                    </span>
                  ))}
                  {incident?.injection?.file === activeTab.path && live && (
                    <button onClick={() => void openDiff(activeTab.path)} title="Compare with the last known good version">
                      <Badge variant="destructive" className="ml-2 h-4 cursor-pointer text-[10px]">
                        bug injected here · view diff
                      </Badge>
                    </button>
                  )}
                </div>
              )}
              <div className="min-h-0 flex-1">
                {activeTab && activeTab.original !== undefined ? (
                  <Suspense fallback={<Skeleton className="m-4 h-40" />}>
                    <CodeDiff path={diffTarget(activeTab.path)} original={activeTab.original} modified={activeTab.content} />
                  </Suspense>
                ) : activeTab ? (
                  <Suspense fallback={<Skeleton className="m-4 h-40" />}>
                    <CodeEditor
                      path={`app/${activeTab.path}`}
                      content={activeTab.content}
                      readOnly={false}
                      reveal={reveal?.path === activeTab.path ? reveal : null}
                      onChange={(value) =>
                        setTabs((current) => current.map((tab) => (tab.path === activeTab.path ? { ...tab, content: value } : tab)))
                      }
                      onSave={() => void save(activeTab.path)}
                      onCursor={(lineNumber, column) => setCursor({ line: lineNumber, column })}
                    />
                  </Suspense>
                ) : (
                  <div className="grid h-full place-items-center text-center text-sm text-[#6e6e6e]">
                    <div className="space-y-1.5">
                      <p className="text-base text-[#8b8b8b]">NightShift Workspace</p>
                      <p>Show All Files · Ctrl + P</p>
                      <p>Search in Files · Ctrl + Shift + F</p>
                      <p>Toggle Terminal · Ctrl + `</p>
                      <p>Save · Ctrl + S · Close Tab · Alt + W</p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Panel: always mounted so the terminal keeps its state */}
            <div
              ref={panelRef}
              style={layout.panel ? { height: layout.panel } : undefined}
              className={cn(
                "relative flex shrink-0 flex-col border-t border-[#2b2b2b] bg-[#181818]",
                !layout.panel && "h-[38%] min-h-[160px]",
                !panelOpen && "hidden",
              )}
            >
              <div
                onPointerDown={dragPanel}
                onDoubleClick={() => {
                  setLayout((current) => ({ ...current, panel: null }));
                  writeStored(LAYOUT_KEY, { ...layoutRef.current, panel: null });
                }}
                title="Drag to resize"
                className="absolute inset-x-0 -top-[3px] z-10 h-1.5 cursor-row-resize hover:bg-[#0078d4]/60"
              />
              <div className="flex h-8 shrink-0 items-center justify-between px-3">
                <div className="flex gap-4 text-[11px] uppercase tracking-wide">
                  {(["terminal", "output", "requests"] as const).map((id) => (
                    <button
                      key={id}
                      onClick={() => setPanel(id)}
                      className={cn("border-b pb-1 pt-1.5", panel === id ? "border-[#e7e7e7] text-[#e7e7e7]" : "border-transparent text-[#9d9d9d] hover:text-[#cccccc]")}
                    >
                      {id === "terminal" ? "Terminal" : id === "output" ? "Output · NightShift" : "Requests"}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1">
                  {panel === "terminal" && <span className="mr-2 text-[11px] text-[#9d9d9d]">powershell · my-app</span>}
                  {panel === "output" && (
                    <button title="Clear Output" onClick={() => setOutput([])} className="grid size-6 place-items-center rounded hover:bg-[#3c3c3c]">
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                  <button title="Close Panel (Ctrl+`)" onClick={() => setPanelOpen(false)} className="grid size-6 place-items-center rounded hover:bg-[#3c3c3c]">
                    <X className="size-3.5" />
                  </button>
                </div>
              </div>
              <div className="relative min-h-0 flex-1">
                <div className={cn("absolute inset-0", panel !== "terminal" && "invisible")}>
                  <Suspense fallback={<p className="p-3 text-xs text-zinc-500">Starting terminal…</p>}>
                    <XtermPanel visible={panelOpen && panel === "terminal"} />
                  </Suspense>
                </div>
                <div ref={outputRef} className={cn("absolute inset-0 overflow-y-auto px-3 py-1 font-mono text-[12.5px] leading-relaxed", panel !== "output" && "invisible")}>
                  {output.length === 0 && <p className="text-zinc-500">NightShift's detections, shadow tests and fixes appear here.</p>}
                  {output.map((entry) => (
                    <div key={entry.id} className="flex gap-2 whitespace-pre-wrap break-words">
                      <span className="shrink-0 text-zinc-600">{entry.at.slice(11, 19)}</span>
                      <span className={cn("shrink-0", TAG_COLOR[entry.tag] ?? "text-zinc-400")}>[{entry.tag}]</span>
                      <span className={TONE_COLOR[entry.tone]}>{entry.text}</span>
                    </div>
                  ))}
                </div>
                {panel === "requests" && (
                  <div className="absolute inset-0">
                    <RequestPanel
                      request={request}
                      response={response}
                      sending={sending}
                      routes={state?.routes ?? []}
                      onChange={setRequest}
                      onSend={() => void send()}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Status bar */}
        <div className={cn("flex h-6 shrink-0 items-center justify-between px-2 text-[12px] text-white", live ? "bg-[#c72e0f]" : "bg-[#0078d4]")}>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <ShieldAlert className="size-3.5" />
              NightShift {live ? `· ${PHASE_META[incident.phase].label}` : state?.running ? "· watching" : "· idle"}
            </span>
            <button onClick={() => { setPanel("terminal"); setPanelOpen(true); }} className="hover:bg-white/15 px-1">
              {state?.running ? `● app up :${4501} via :${state.proxyPort}` : "○ app stopped"}
            </button>
            {health && state?.running && (
              <span>
                {percent(health.errorRate)} errors · p95 {health.p95Ms} ms
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {notice && <span className="truncate">{notice}</span>}
            {activeTab && (
              <>
                <span>
                  Ln {cursor.line}, Col {cursor.column}
                </span>
                <span>Spaces: 2</span>
                <span>UTF-8</span>
                <span className="capitalize">{languageOf(activeTab.path)}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* NightShift side panel */}
      <section className="hidden w-[290px] shrink-0 flex-col gap-3 overflow-y-auto xl:flex">
        <div className="rounded-xl border bg-card p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Your app</p>
            {state?.running ? (
              <Badge variant={failing ? "destructive" : "success"}>
                <StatusDot className={failing ? "bg-rose-500" : "bg-emerald-400"} pulse />
                {failing ? "Failing" : "Running"}
              </Badge>
            ) : (
              <Badge variant="muted">Stopped</Badge>
            )}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">{state?.command ?? "start it from the terminal: npm start"}</p>
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
              <Button
                size="sm"
                variant="outline"
                className="flex-1"
                disabled={empty || entries === null}
                onClick={() => {
                  setPanel("terminal");
                  setPanelOpen(true);
                  void api.app.exec(state?.command ?? "npm start");
                }}
              >
                <Play />
                {state?.command ?? "npm start"}
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

        {!empty && entries !== null && (
          <div className="rounded-xl border bg-card p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Endpoints</p>
              {state?.running && (
                <a
                  href={`http://localhost:${state.proxyPort}/`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  Open app <ExternalLink className="size-3" />
                </a>
              )}
            </div>
            {!state?.running ? (
              <p className="text-xs text-muted-foreground">Start the app to try its routes.</p>
            ) : (
              <ul className="space-y-1">
                {(state.routes ?? []).map((route) => (
                  <li key={route}>
                    <button
                      onClick={() => void send({ method: "GET", path: route, body: "" })}
                      title={`GET ${route} through NightShift's proxy`}
                      className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left font-mono text-xs hover:bg-muted"
                    >
                      <span className="text-emerald-400">GET</span>
                      <span className="truncate">{route}</span>
                      <Send className="ml-auto size-3 opacity-0 group-hover:opacity-70" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="rounded-xl border bg-card p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">NightShift</p>
            {incident && <Badge variant={PHASE_META[incident.phase].variant}>{PHASE_META[incident.phase].label}</Badge>}
          </div>
          {!incident ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <StatusDot className="bg-emerald-400" pulse />
              {state?.running ? (state.hasSnapshot ? "On watch. Last known good code saved." : "On watch.") : "Waiting for your app to start."}
            </p>
          ) : (
            <div className="space-y-2.5 text-sm">
              {incident.injection && (
                <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-xs text-rose-200">
                  <ShieldAlert className="mr-1 inline size-3.5" />
                  {incident.injection.injectedBy} changed <span className="font-mono">{incident.injection.file}</span>: {incident.injection.description}
                  <button
                    onClick={() => incident.injection && void openDiff(incident.injection.file)}
                    className="mt-1.5 flex items-center gap-1 rounded border border-rose-400/40 px-1.5 py-0.5 text-[11px] text-rose-100 hover:bg-rose-500/20"
                  >
                    <GitCompare className="size-3" />
                    View diff
                  </button>
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Trigger: {incident.trigger.reachable ? `${percent(incident.trigger.errorRate)} errors` : "app unreachable"}
                {incident.changedFiles.length > 0 && (
                  <>
                    {" "}
                    · changed:{" "}
                    {incident.changedFiles.map((file, index) => (
                      <span key={file}>
                        {index > 0 && ", "}
                        <button onClick={() => void openDiff(file)} title="Compare with the last known good version" className="font-mono underline decoration-dotted hover:text-foreground">
                          {file}
                        </button>
                      </span>
                    ))}
                  </>
                )}
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

      {/* Context menu */}
      {menu && (
        <div
          className="fixed z-50 min-w-[200px] rounded-md border border-[#454545] bg-[#252526] py-1 text-[13px] text-[#cccccc] shadow-2xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          {[
            { label: "New File...", icon: FilePlus2, run: () => startCreate("file", menu.node), show: true },
            { label: "New Folder...", icon: FolderPlus, run: () => startCreate("folder", menu.node), show: true },
            { label: "Open", icon: FileCode2, run: () => menu.node && void openFile(menu.node.path), show: Boolean(menu.node && !menu.node.dir) },
            {
              label: "Compare with Last Good",
              icon: GitCompare,
              run: () => menu.node && void openDiff(menu.node.path),
              show: Boolean(menu.node && !menu.node.dir && state?.hasSnapshot),
            },
            {
              label: "Copy Relative Path",
              icon: Copy,
              run: () => menu.node && void navigator.clipboard?.writeText(menu.node.path),
              show: Boolean(menu.node),
            },
            {
              label: "Rename...",
              icon: Pencil,
              run: () => menu.node && setPending({ kind: "rename", parent: parentOf(menu.node.path), path: menu.node.path, value: menu.node.name }),
              show: Boolean(menu.node),
            },
            { label: "Delete", icon: Trash2, run: () => menu.node && void remove(menu.node), show: Boolean(menu.node) },
            { label: "Download Folder (.zip)", icon: Download, run: download, show: !menu.node && !empty, divider: true },
            { label: "Close Folder", icon: FolderX, run: () => void closeFolder(), show: !menu.node && !empty },
          ]
            .filter((item) => item.show)
            .map((item) => (
              <button
                key={item.label}
                onClick={() => {
                  setMenu(null);
                  item.run();
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-[#04395e]",
                  "divider" in item && item.divider && "mt-1 border-t border-[#454545] pt-1.5",
                )}
              >
                <item.icon className="size-3.5 text-zinc-400" />
                {item.label}
              </button>
            ))}
        </div>
      )}

      {/* Tab context menu */}
      {tabMenu && (
        <div
          className="fixed z-50 min-w-[200px] rounded-md border border-[#454545] bg-[#252526] py-1 text-[13px] text-[#cccccc] shadow-2xl"
          style={{ left: tabMenu.x, top: tabMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          {(() => {
            const index = tabs.findIndex((tab) => tab.path === tabMenu.path);
            const target = tabs[index];
            const file = target?.original !== undefined ? diffTarget(tabMenu.path) : tabMenu.path;
            return [
              { label: "Close", hint: "Alt+W", run: () => closeTabs([tabMenu.path]), show: true },
              { label: "Close Others", run: () => closeTabs(tabs.filter((tab) => tab.path !== tabMenu.path).map((tab) => tab.path)), show: tabs.length > 1 },
              { label: "Close to the Right", run: () => closeTabs(tabs.slice(index + 1).map((tab) => tab.path)), show: index < tabs.length - 1 },
              { label: "Close Saved", run: () => closeTabs(tabs.filter((tab) => tab.content === tab.saved).map((tab) => tab.path)), show: true },
              { label: "Close All", run: () => closeTabs(tabs.map((tab) => tab.path)), show: true },
              { label: "Copy Relative Path", run: () => void navigator.clipboard?.writeText(file), show: true, divider: true },
              { label: "Compare with Last Good", run: () => void openDiff(file), show: target?.original === undefined && Boolean(state?.hasSnapshot) },
            ]
              .filter((item) => item.show)
              .map((item) => (
                <button
                  key={item.label}
                  onClick={() => {
                    setTabMenu(null);
                    item.run();
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-4 px-3 py-1 text-left hover:bg-[#04395e]",
                    item.divider && "mt-1 border-t border-[#454545] pt-1.5",
                  )}
                >
                  {item.label}
                  {item.hint && <span className="text-[11px] text-zinc-500">{item.hint}</span>}
                </button>
              ));
          })()}
        </div>
      )}

      {/* Quick open (Ctrl+P) */}
      {quickOpen && (
        <div className="fixed inset-0 z-50" onClick={() => setQuickOpen(false)}>
          <div
            className="mx-auto mt-24 w-[560px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-[#454545] bg-[#252526] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setQuickOpen(false);
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setPick((index) => Math.min(index + 1, matches.length - 1));
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setPick((index) => Math.max(index - 1, 0));
                }
                if (event.key === "Enter" && matches[pick]) {
                  void openFile(matches[pick].path);
                  setQuickOpen(false);
                }
              }}
              placeholder="Search files by name"
              className="w-full border-b border-[#454545] bg-[#3c3c3c] px-3 py-2 text-[13px] text-white outline-none placeholder:text-zinc-500"
            />
            <ul className="max-h-80 overflow-y-auto py-1">
              {matches.length === 0 && <li className="px-3 py-2 text-[13px] text-zinc-500">No matching files</li>}
              {matches.map((file, index) => (
                <li key={file.path}>
                  <button
                    onMouseEnter={() => setPick(index)}
                    onClick={() => {
                      void openFile(file.path);
                      setQuickOpen(false);
                    }}
                    className={cn("flex w-full items-center gap-2 px-3 py-1 text-left text-[13px]", index === pick ? "bg-[#04395e] text-white" : "text-[#cccccc]")}
                  >
                    <FileIcon path={file.path} className="size-3.5 shrink-0" />
                    {nameOf(file.path)}
                    <span className="truncate text-xs text-zinc-500">{parentOf(file.path)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
