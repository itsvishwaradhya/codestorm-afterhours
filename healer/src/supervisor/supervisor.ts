import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ServiceName, ServiceRecord } from "@nightshift/shared";

const servicePath = fileURLToPath(new URL("../../../services/src/service.ts", import.meta.url));

function launch(service: ServiceRecord, env: NodeJS.ProcessEnv, stdio: "inherit" | "ignore"): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", servicePath], {
    env: { ...process.env, ...env, SERVICE_NAME: service.name },
    stdio,
  });
}

export interface CloneHandle {
  stop: () => Promise<void>;
}

export class Supervisor {
  private children = new Map<ServiceName, ChildProcess>();

  constructor(private readonly healerUrl: string) {}

  start(services: ServiceRecord[]): void {
    for (const service of services) {
      this.spawn(service);
    }
  }

  private spawn(service: ServiceRecord): void {
    const child = launch(
      service,
      { PORT: String(service.port), HEALER_URL: this.healerUrl },
      "inherit",
    );
    this.children.set(service.name, child);
    child.on("exit", (code, signal) => {
      if (this.children.get(service.name) === child) {
        console.log(
          `[supervisor] ${service.name} exited (code ${code}, signal ${signal}). Not restarted: healing happens only through a verified fix.`,
        );
      }
    });
  }

  async restart(service: ServiceRecord): Promise<void> {
    const old = this.children.get(service.name);
    this.children.delete(service.name);
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
