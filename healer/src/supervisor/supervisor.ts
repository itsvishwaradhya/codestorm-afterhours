import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ServiceRecord } from "@nightshift/shared";

const servicePath = fileURLToPath(new URL("../../../services/src/service.ts", import.meta.url));

export class Supervisor {
  private children: ChildProcess[] = [];

  start(services: ServiceRecord[], healerUrl: string): void {
    for (const service of services) {
      const child = spawn(process.execPath, ["--import", "tsx", servicePath], {
        env: {
          ...process.env,
          SERVICE_NAME: service.name,
          PORT: String(service.port),
          HEALER_URL: healerUrl,
        },
        stdio: "inherit",
      });
      child.on("exit", (code, signal) => {
        console.log(
          `[supervisor] ${service.name} exited (code ${code}, signal ${signal}). Not restarted: healing happens only through a verified fix.`,
        );
      });
      this.children.push(child);
    }
  }

  stop(): void {
    for (const child of this.children) {
      child.kill();
    }
    this.children = [];
  }
}
