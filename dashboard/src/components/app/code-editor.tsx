import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// Bundle Monaco locally instead of loading it from a CDN, so the demo works offline.
self.MonacoEnvironment = {
  getWorker: (_id, label) => (label === "typescript" || label === "javascript" ? new tsWorker() : new editorWorker()),
};
loader.config({ monaco });

// The workspace shows source out of context, so import errors would only be noise.
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: true,
});

export default function CodeEditor({ path, content }: { path: string; content: string }) {
  return (
    <Editor
      path={path}
      value={content}
      language="typescript"
      theme="vs-dark"
      options={{
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: "JetBrains Mono, ui-monospace, monospace",
        scrollBeyondLastLine: false,
        renderLineHighlight: "none",
        padding: { top: 12 },
        automaticLayout: true,
      }}
    />
  );
}
