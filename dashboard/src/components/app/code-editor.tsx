import { useEffect, useRef } from "react";
import Editor, { DiffEditor, loader, type DiffOnMount, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";

// Bundle Monaco locally instead of loading it from a CDN, so the demo works offline.
self.MonacoEnvironment = {
  getWorker: (_id, label) => {
    if (label === "typescript" || label === "javascript") return new tsWorker();
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html") return new htmlWorker();
    return new editorWorker();
  },
};
loader.config({ monaco });

// Files are shown out of their project's context, so import errors would only be noise.
for (const defaults of [monaco.languages.typescript.typescriptDefaults, monaco.languages.typescript.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
}

const LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  css: "css",
  scss: "scss",
  html: "html",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  env: "ini",
};

export const languageOf = (path: string): string => LANGUAGE[path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";

export interface CodeEditorProps {
  path: string;
  content: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onSave?: () => void;
  onCursor?: (line: number, column: number) => void;
  // Jumps to a position; a new object (even for the same line) jumps again.
  reveal?: { line: number; column: number } | null;
}

export default function CodeEditor({ path, content, readOnly = true, onChange, onSave, onCursor, reveal }: CodeEditorProps) {
  // Monaco commands are registered once; keep the latest callbacks in refs.
  const save = useRef(onSave);
  const cursor = useRef(onCursor);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  useEffect(() => {
    save.current = onSave;
    cursor.current = onCursor;
  });

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !reveal) return;
    editor.setPosition({ lineNumber: reveal.line, column: reveal.column });
    editor.revealLineInCenter(reveal.line);
    editor.focus();
  }, [reveal, path]);

  const onMount: OnMount = (editor, api) => {
    editorRef.current = editor;
    editor.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.KeyS, () => save.current?.());
    editor.onDidChangeCursorPosition((event) => cursor.current?.(event.position.lineNumber, event.position.column));
    if (reveal) {
      editor.setPosition({ lineNumber: reveal.line, column: reveal.column });
      editor.revealLineInCenter(reveal.line);
    }
    editor.focus();
  };

  return (
    <Editor
      path={path}
      value={content}
      language={languageOf(path)}
      theme="vs-dark"
      onMount={onMount}
      onChange={(value) => onChange?.(value ?? "")}
      options={{
        readOnly,
        domReadOnly: readOnly,
        minimap: { enabled: !readOnly },
        fontSize: 13,
        fontFamily: "JetBrains Mono, Consolas, ui-monospace, monospace",
        scrollBeyondLastLine: false,
        renderLineHighlight: readOnly ? "none" : "line",
        padding: { top: 8 },
        automaticLayout: true,
        tabSize: 2,
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: true },
        smoothScrolling: true,
        cursorBlinking: "smooth",
      }}
    />
  );
}

export interface DiffStats {
  changes: number;
  added: number;
  removed: number;
}

// Read-only comparison: left is the older version, right the newer one. `id` keeps the models
// of two diffs of the same file (for example "the bug" and "now") apart.
export function CodeDiff({
  id,
  path,
  original,
  modified,
  inline = false,
  onStats,
}: {
  id: string;
  path: string;
  original: string;
  modified: string;
  inline?: boolean;
  onStats?: (stats: DiffStats) => void;
}) {
  const stats = useRef(onStats);
  useEffect(() => {
    stats.current = onStats;
  });

  const onMount: DiffOnMount = (editor) => {
    // A reused model keeps its old text; make sure both sides show what was passed in.
    const models = editor.getModel();
    if (models && models.original.getValue() !== original) models.original.setValue(original);
    if (models && models.modified.getValue() !== modified) models.modified.setValue(modified);
    const report = () => {
      // null until the worker has finished the first comparison.
      const changes = editor.getLineChanges();
      if (!changes) return;
      const span = (start: number, end: number) => (end >= start && end > 0 ? end - start + 1 : 0);
      stats.current?.({
        changes: changes.length,
        added: changes.reduce((sum, change) => sum + span(change.modifiedStartLineNumber, change.modifiedEndLineNumber), 0),
        removed: changes.reduce((sum, change) => sum + span(change.originalStartLineNumber, change.originalEndLineNumber), 0),
      });
    };
    editor.onDidUpdateDiff(report);
    report();
  };

  return (
    <DiffEditor
      original={original}
      modified={modified}
      originalModelPath={`${id}/before/${path}`}
      modifiedModelPath={`${id}/after/${path}`}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      language={languageOf(path)}
      theme="vs-dark"
      onMount={onMount}
      options={{
        readOnly: true,
        originalEditable: false,
        renderSideBySide: !inline,
        // Without this Monaco silently switches to inline under 900 px, which is most of the time here.
        useInlineViewWhenSpaceIsLimited: false,
        hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 5, revealLineCount: 10 },
        ignoreTrimWhitespace: false,
        renderIndicators: true,
        renderOverviewRuler: true,
        fontSize: 13,
        fontFamily: "JetBrains Mono, Consolas, ui-monospace, monospace",
        scrollBeyondLastLine: false,
        automaticLayout: true,
        minimap: { enabled: false },
      }}
    />
  );
}
