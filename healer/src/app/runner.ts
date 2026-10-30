import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { REPO_ROOT } from "./files.js";
import { APP_PORT, type AppTerminal } from "./terminal.js";

export interface AppLog {
  source: "app" | "clone" | "nightshift";
  line: string;
  stream: "stdout" | "stderr" | "system";
  at: string;
}

function killPid(pid: number): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

// With shell: true, kill() only stops the shell on Windows; take the whole tree down.
function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return resolve();
    child.once("exit", () => resolve());
    killPid(child.pid);
    setTimeout(resolve, 3000);
  });
}

// The process listening on a port, so NightShift can stop a server the user started in the terminal.
export function portOwner(port: number): number | null {
  try {
    if (process.platform === "win32") {
      const output = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
      for (const row of output.split(/\r?\n/)) {
        const cols = row.trim().split(/\s+/);
        if (cols[3] === "LISTENING" && cols[1]?.endsWith(`:${port}`)) return Number(cols[4]) || null;
      }
      return null;
    }
    const output = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    return Number(output.split("\n")[0]) || null;
  } catch {
    return null;
  }
}

export function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(800, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export async function waitForPort(port: number, timeoutMs: number, open = true): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await isPortOpen(port)) === open) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

// The app itself runs in the user's terminal. NightShift stops it by port and starts it again by
// typing the user's own command, so the output stays where the user is looking.
export class AppRunner {
  running = false;

  constructor(
    private readonly terminal: AppTerminal,
    private readonly onLog: (entry: AppLog) => void,
  ) {}

  status(): { running: boolean; command: string | null; pid: number | null } {
    return { running: this.running, command: this.terminal.lastServerCommand, pid: this.running ? portOwner(APP_PORT) : null };
  }

  async stop(): Promise<void> {
    const pid = portOwner(APP_PORT);
    if (pid) {
      killPid(pid);
      await waitForPort(APP_PORT, 5000, false);
    }
    this.running = false;
  }

  async restart(): Promise<void> {
    const command = this.terminal.lastServerCommand;
    if (!command) return;
    await this.stop();
    // Give the shell a moment to print npm's exit before the next prompt.
    await new Promise((resolve) => setTimeout(resolve, 800));
    this.terminal.run(command);
  }

  // Starts the remembered server command in a clone directory for a shadow test, out of sight.
  clone(cwd: string, port: number): { stop: () => Promise<void> } | null {
    const command = this.terminal.lastServerCommand;
    if (!command) return null;
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, PORT: String(port), NODE_PATH: path.join(REPO_ROOT, "node_modules"), FORCE_COLOR: "0" },
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const log = (stream: AppLog["stream"]) => (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) this.onLog({ source: "clone", line, stream, at: new Date().toISOString() });
      }
    };
    child.stdout?.on("data", log("stdout"));
    child.stderr?.on("data", log("stderr"));
    return { stop: () => killTree(child) };
  }
}
