import { useEffect, useRef } from "react";
import { io } from "socket.io-client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// A real terminal attached to the healer's shared shell. Keystrokes (Ctrl+C, Tab, arrows) go
// straight to the shell and output is drawn in place, exactly like VS Code's integrated terminal.
export default function XtermPanel({ visible }: { visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "JetBrains Mono, Consolas, ui-monospace, monospace",
      fontSize: 13,
      scrollback: 5000,
      allowProposedApi: false,
      theme: {
        background: "#181818",
        foreground: "#cccccc",
        cursor: "#ffffff",
        selectionBackground: "#264f78",
        black: "#000000",
        brightBlack: "#666666",
        red: "#f14c4c",
        green: "#23d18b",
        yellow: "#f5f543",
        blue: "#3b8eea",
        magenta: "#d670d6",
        cyan: "#29b8db",
        white: "#e5e5e5",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fitRef.current = fit;
    termRef.current = term;

    const socket = io();
    const sendSize = () => {
      try {
        fit.fit();
        socket.emit("pty-resize", { cols: term.cols, rows: term.rows });
      } catch {
        // not laid out yet
      }
    };
    socket.on("connect", () => {
      term.reset();
      socket.emit("pty-attach");
      sendSize();
    });
    socket.on("pty-data", (data: string) => term.write(data));

    // Ctrl+C copies when text is selected (VS Code behaviour) and otherwise interrupts.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      if (event.type === "keydown" && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
        void navigator.clipboard?.readText().then((text) => socket.emit("pty-input", text));
        return false;
      }
      return true;
    });
    const input = term.onData((data) => socket.emit("pty-input", data));

    const observer = new ResizeObserver(() => sendSize());
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      input.dispose();
      socket.disconnect();
      term.dispose();
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // ignore
      }
      termRef.current?.focus();
    }, 30);
    return () => clearTimeout(timer);
  }, [visible]);

  return <div ref={host} className="h-full w-full px-2 pt-1" />;
}
