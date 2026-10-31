import { useEffect, useRef } from "react";
import Editor, { DiffEditor, loader, type OnMount } from "@monaco-editor/react";
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

// Side-by-side, read-only comparison (last known good on the left, current file on the right).
export function CodeDiff({ path, original, modified }: { path: string; original: string; modified: string }) {
  return (
    <DiffEditor
      original={original}
      modified={modified}
      originalModelPath={`good/${path}`}
      modifiedModelPath={`diff/${path}`}
      language={languageOf(path)}
      theme="vs-dark"
      options={{
        readOnly: true,
        originalEditable: false,
        renderSideBySide: true,
        fontSize: 13,
        fontFamily: "JetBrains Mono, Consolas, ui-monospace, monospace",
        scrollBeyondLastLine: false,
        automaticLayout: true,
        minimap: { enabled: false },
      }}
    />
  );
}
