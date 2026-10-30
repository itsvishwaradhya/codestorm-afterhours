import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { APP_ROOT, REPO_ROOT } from "./files.js";

export const APP_PORT = 4501;

export interface AppLog {
  source: "app" | "shell" | "clone" | "nightshift";
  line: string;
  stream: "stdout" | "stderr" | "system";
  at: string;
}

// Commands that start a long-running server become the app process NightShift watches.
const SERVER_COMMAND = /^(npm\s+(start|run\s+(dev|start|serve))|node\s+\S+|npx\s+nodemon\s+\S+)\s*$/;

export const isServerCommand = (command: string): boolean => SERVER_COMMAND.test(command.trim());

// With shell: true, kill() only stops the shell on Windows; take the whole tree down.
function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return resolve();
    child.once("exit", () => resolve());
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
    setTimeout(resolve, 3000);
  });
}

export async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  return false;
}

export class AppRunner {
  private app: ChildProcess | null = null;
  private command: string | null = null;

  constructor(private readonly onLog: (entry: AppLog) => void) {}

  private log(source: AppLog["source"], line: string, stream: AppLog["stream"] = "system"): void {
    this.onLog({ source, line, stream, at: new Date().toISOString() });
  }

  private launch(command: string, cwd: string, port: number, source: AppLog["source"]): ChildProcess {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_PATH: path.join(REPO_ROOT, "node_modules"),
        FORCE_COLOR: "0",
      },
    });
    for (const stream of ["stdout", "stderr"] as const) {
      let buffered = "";
      child[stream]?.setEncoding("utf8");
      child[stream]?.on("data", (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) this.log(source, line, stream);
      });
    }
    return child;
  }

  status(): { running: boolean; command: string | null; pid: number | null } {
    const running = this.app !== null && this.app.exitCode === null && this.app.signalCode === null;
    return { running, command: this.command, pid: running ? (this.app?.pid ?? null) : null };
  }

  async exec(command: string): Promise<void> {
    if (isServerCommand(command)) {
      await this.start(command);
      return;
    }
    this.log("shell", `$ ${command}`);
    const child = this.launch(command, APP_ROOT, APP_PORT, "shell");
    child.on("exit", (code) => this.log("shell", `exited with code ${code}`));
  }

  async start(command: string): Promise<void> {
    await this.stop();
    this.command = command;
    this.log("app", `starting \`${command}\` on port ${APP_PORT} (traffic goes through the proxy on 4500)`);
    const child = this.launch(command, APP_ROOT, APP_PORT, "app");
    this.app = child;
    child.on("exit", (code) => {
      if (this.app === child) this.log("app", `app process exited (code ${code})`, "stderr");
    });
  }

  async restart(): Promise<void> {
    if (this.command) await this.start(this.command);
  }

  async stop(): Promise<void> {
    const old = this.app;
    this.app = null;
    if (old) {
      await killTree(old);
      this.log("app", "app process stopped");
    }
  }

  // Starts the remembered server command in a clone directory for a shadow test.
  clone(cwd: string, port: number): { stop: () => Promise<void> } | null {
    if (!this.command) return null;
    const child = this.launch(this.command, cwd, port, "clone");
    return { stop: () => killTree(child) };
  }
}
