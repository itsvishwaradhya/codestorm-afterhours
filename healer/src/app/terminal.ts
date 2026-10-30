import path from "node:path";
import * as pty from "node-pty";
import { APP_ROOT, REPO_ROOT } from "./files.js";

export const APP_PORT = 4501;
const SCROLLBACK_CHARS = 200_000;

// Commands that start a long-running server; NightShift remembers the last one typed so it can
// restart the app exactly the way the user did.
const SERVER_COMMAND = /^(npm\s+(start|run\s+(dev|start|serve))|node\s+\S+|npx\s+nodemon\s+\S+)\s*$/;
export const isServerCommand = (command: string): boolean => SERVER_COMMAND.test(command.trim());

// One shared, real shell in the uploaded app's folder, streamed to every browser over Socket.IO.
// Localhost only: whoever can open the dashboard can run commands on this machine.
export class AppTerminal {
  private shell: pty.IPty | null = null;
  private scrollback = "";
  private typed = "";
  private size = { cols: 120, rows: 30 };
  lastServerCommand: string | null = null;
  lastInterruptAt = 0;

  constructor(private readonly emit: (data: string) => void) {}

  start(): void {
    if (this.shell) return;
    const windows = process.platform === "win32";
    const shell = pty.spawn(
      windows ? "powershell.exe" : process.env.SHELL || "bash",
      windows ? ["-NoLogo", "-ExecutionPolicy", "Bypass"] : [],
      {
        name: "xterm-256color",
        cwd: APP_ROOT,
        ...this.size,
        env: {
          ...process.env,
          PORT: String(APP_PORT),
          NODE_PATH: path.join(REPO_ROOT, "node_modules"),
        } as Record<string, string>,
      },
    );
    shell.onData((data) => {
      this.scrollback = (this.scrollback + data).slice(-SCROLLBACK_CHARS);
      this.emit(data);
    });
    shell.onExit(() => {
      if (this.shell === shell) this.shell = null;
    });
    this.shell = shell;
  }

  kill(): void {
    const shell = this.shell;
    this.shell = null;
    this.scrollback = "";
    shell?.kill();
  }

  restart(): void {
    this.kill();
    this.emit("\x1bc");
    this.start();
  }

  history(): string {
    return this.scrollback;
  }

  // Keystrokes from the browser. A light line tracker notices server commands and Ctrl+C.
  input(data: string): void {
    if (!this.shell) this.start();
    for (const char of data) {
      if (char === "\r") {
        if (isServerCommand(this.typed)) this.lastServerCommand = this.typed.trim();
        this.typed = "";
      } else if (char === "\x03") {
        this.lastInterruptAt = Date.now();
        this.typed = "";
      } else if (char === "\x7f" || char === "\b") {
        this.typed = this.typed.slice(0, -1);
      } else if (char >= " " && !data.startsWith("\x1b")) {
        this.typed += char;
      }
    }
    this.shell?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || rows < 3 || cols > 500 || rows > 200) return;
    this.size = { cols, rows };
    this.shell?.resize(cols, rows);
  }

  // Runs a command as if the user typed it, so its output stays in the terminal they are watching.
  run(command: string): void {
    if (!this.shell) this.start();
    this.lastServerCommand = isServerCommand(command) ? command : this.lastServerCommand;
    this.shell?.write(`${command}\r`);
  }
}
