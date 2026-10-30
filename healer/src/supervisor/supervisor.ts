import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ServiceName, ServiceRecord } from "@nightshift/shared";

const servicePath = fileURLToPath(new URL("../../../services/src/service.ts", import.meta.url));

function launch(service: ServiceRecord, env: NodeJS.ProcessEnv, stdio: "pipe" | "ignore"): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", servicePath], {
    env: { ...process.env, ...env, SERVICE_NAME: service.name },
    stdio,
  });
}

export interface LogLine {
  service: ServiceName;
  stream: "stdout" | "stderr" | "supervisor";
  line: string;
  at: string;
}

export type LogSink = (entry: LogLine) => void;

export interface CloneHandle {
  stop: () => Promise<void>;
}

export class Supervisor {
  private children = new Map<ServiceName, ChildProcess>();

  constructor(
    private readonly healerUrl: string,
    private readonly onLog: LogSink = () => undefined,
  ) {}

  private log(service: ServiceName, stream: LogLine["stream"], line: string): void {
    this.onLog({ service, stream, line, at: new Date().toISOString() });
  }

  // Production output still reaches the console, and each line is also handed to the log sink.
  private forward(service: ServiceName, child: ChildProcess): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const source = child[stream];
      if (!source) continue;
      let buffered = "";
      source.setEncoding("utf8");
      source.on("data", (chunk: string) => {
        (stream === "stdout" ? process.stdout : process.stderr).write(chunk);
        buffered += chunk;
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) this.log(service, stream, line);
      });
    }
  }

  start(services: ServiceRecord[]): void {
    for (const service of services) {
      this.spawn(service);
    }
  }

  private spawn(service: ServiceRecord): void {
    const child = launch(
      service,
      { PORT: String(service.port), HEALER_URL: this.healerUrl },
      "pipe",
    );
    this.children.set(service.name, child);
    this.forward(service.name, child);
    this.log(service.name, "supervisor", `started (pid ${child.pid})`);
    child.on("exit", (code, signal) => {
      if (this.children.get(service.name) === child) {
        const message = `exited (code ${code}, signal ${signal}). Not restarted: healing happens only through a verified fix.`;
        console.log(`[supervisor] ${service.name} ${message}`);
        this.log(service.name, "supervisor", message);
      }
    });
  }

  async restart(service: ServiceRecord): Promise<void> {
    const old = this.children.get(service.name);
    this.children.delete(service.name);
    this.log(service.name, "supervisor", "restarting");
    if (old && old.exitCode === null && old.signalCode === null) {
      await new Promise<void>((resolve) => {
        old.once("exit", () => resolve());
        old.kill();
      });
    }
    this.spawn(service);
  }

  spawnClone(service: ServiceRecord, port: number): CloneHandle {
    const child = launch(
      service,
      { PORT: String(port), SHADOW: "1", HEALER_URL: this.healerUrl },
      "ignore",
    );
    return {
      stop: () =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
          child.kill();
        }),
    };
  }

  stop(): void {
    for (const child of this.children.values()) {
      child.kill();
    }
    this.children.clear();
  }
}
