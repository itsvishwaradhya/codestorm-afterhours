import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { CaseSensitive, ChevronDown, ChevronRight, Loader2, Regex } from "lucide-react";
import { api, type WorkspaceFile } from "@/api";
import { cn } from "@/lib/utils";

const MAX_HITS = 1000;

interface Hit {
  line: number;
  column: number;
  length: number;
  text: string;
}

function matcher(query: string, regex: boolean, caseSensitive: boolean): RegExp | string {
  const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(source, caseSensitive ? "g" : "gi");
  } catch (error) {
    return error instanceof Error ? error.message : "invalid pattern";
  }
}

// Find in files (Ctrl+Shift+F). Unsaved editor content wins over what is on disk.
export function SearchPanel({
  files,
  overlay,
  focusSignal,
  onOpen,
}: {
  files: WorkspaceFile[];
  overlay: Map<string, string>;
  focusSignal: number;
  onOpen: (path: string, line: number, column: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [contents, setContents] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const cache = useRef(new Map<string, { size: number; content: string }>());
  const input = useRef<HTMLInputElement>(null);
  const searching = query !== "";
  const deferred = useDeferredValue(query);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusSignal]);

  // Load file contents once per size change; the tree's sizes come from disk.
  useEffect(() => {
    if (!searching) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const next = new Map<string, string>();
      for (const file of files) {
        const hit = cache.current.get(file.path);
        if (hit && hit.size === file.size) {
          next.set(file.path, hit.content);
          continue;
        }
        const loaded = await api.app.file(file.path).catch(() => null);
        if (cancelled) return;
        if (loaded) {
          cache.current.set(file.path, { size: file.size, content: loaded.content });
          next.set(file.path, loaded.content);
        }
      }
      if (!cancelled) {
        setContents(next);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [files, searching]);

  const pattern = useMemo(() => (deferred ? matcher(deferred, regex, caseSensitive) : null), [deferred, regex, caseSensitive]);

  const results = useMemo(() => {
    if (!pattern || typeof pattern === "string") return { groups: [] as { path: string; hits: Hit[] }[], total: 0, capped: false };
    const groups: { path: string; hits: Hit[] }[] = [];
    let total = 0;
    for (const file of files) {
      const content = overlay.get(file.path) ?? contents.get(file.path);
      if (content === undefined) continue;
      const hits: Hit[] = [];
      content.split(/\r?\n/).forEach((text, index) => {
        if (total + hits.length >= MAX_HITS) return;
        pattern.lastIndex = 0;
        const match = pattern.exec(text);
        if (match && match[0].length > 0) hits.push({ line: index + 1, column: match.index + 1, length: match[0].length, text });
      });
      if (hits.length) {
        groups.push({ path: file.path, hits });
        total += hits.length;
      }
      if (total >= MAX_HITS) break;
    }
    return { groups, total, capped: total >= MAX_HITS };
  }, [pattern, files, contents, overlay]);

  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1.5 px-3 pb-2">
        <div className="flex items-center border border-[#3c3c3c] bg-[#313131] focus-within:border-[#007fd4]">
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent px-1.5 py-1 text-[13px] text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          {[
            { title: "Match Case", icon: CaseSensitive, on: caseSensitive, set: setCaseSensitive },
            { title: "Use Regular Expression", icon: Regex, on: regex, set: setRegex },
          ].map((option) => (
            <button
              key={option.title}
              title={option.title}
              onClick={() => option.set((value) => !value)}
              className={cn("mr-0.5 grid size-5 place-items-center rounded", option.on ? "border border-[#007fd4] bg-[#0078d4]/30 text-white" : "text-zinc-400 hover:bg-[#3c3c3c]")}
            >
              <option.icon className="size-3.5" />
            </button>
          ))}
        </div>
        {searching && (
          <p className="flex items-center gap-1.5 text-[11px] text-zinc-500">
            {loading && <Loader2 className="size-3 animate-spin" />}
            {typeof pattern === "string"
              ? <span className="text-rose-400">{pattern}</span>
              : `${results.total}${results.capped ? "+" : ""} result${results.total === 1 ? "" : "s"} in ${results.groups.length} file${results.groups.length === 1 ? "" : "s"}`}
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {results.groups.map((group) => {
          const open = !collapsed.has(group.path);
          const slash = group.path.lastIndexOf("/");
          return (
            <div key={group.path}>
              <button onClick={() => toggle(group.path)} className="flex w-full items-center gap-1 px-2 py-[3px] text-left text-[13px] text-[#cccccc] hover:bg-[#2a2d2e]">
                {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
                <span className="truncate">{group.path.slice(slash + 1)}</span>
                {slash > 0 && <span className="truncate text-[11px] text-zinc-500">{group.path.slice(0, slash)}</span>}
                <span className="ml-auto rounded-full bg-[#4d4d4d] px-1.5 text-[10px]">{group.hits.length}</span>
              </button>
              {open &&
                group.hits.map((hit) => {
                  // Trim long lines so the match stays visible.
                  const start = Math.max(0, hit.column - 1 - 24);
                  const before = (start > 0 ? "…" : "") + hit.text.slice(start, hit.column - 1).trimStart();
                  const match = hit.text.slice(hit.column - 1, hit.column - 1 + hit.length);
                  const after = hit.text.slice(hit.column - 1 + hit.length);
                  return (
                    <button
                      key={hit.line}
                      onClick={() => onOpen(group.path, hit.line, hit.column)}
                      title={`${group.path}:${hit.line}`}
                      className="flex w-full items-center gap-2 truncate py-[2px] pl-8 pr-2 text-left font-mono text-[12px] text-[#bbbbbb] hover:bg-[#2a2d2e]"
                    >
                      <span className="truncate">
                        {before}
                        <span className="rounded-sm bg-[#623315] text-white">{match}</span>
                        {after}
                      </span>
                    </button>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
