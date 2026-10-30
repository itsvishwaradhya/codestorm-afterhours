import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SERVICE_NAMES } from "@nightshift/shared";

const servicePath = fileURLToPath(new URL("./service.ts", import.meta.url));
const children: ChildProcess[] = [];

for (const name of SERVICE_NAMES) {
  const child = spawn(process.execPath, ["--import", "tsx", servicePath], {
    env: { ...process.env, SERVICE_NAME: name },
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    console.log(`[start-all] ${name} exited (code ${code}, signal ${signal})`);
  });
  children.push(child);
}

function shutdown(): void {
  for (const child of children) {
    child.kill();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
