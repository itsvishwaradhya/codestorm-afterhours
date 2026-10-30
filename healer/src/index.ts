import { randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import type { AuditEntry, ServiceName, Snapshot } from "@nightshift/shared";
import { registerRoutes } from "./api/routes.js";
import { startCollector, waitForServices } from "./collect/collector.js";
import { config } from "./config.js";
import { createDetector } from "./detect/detector.js";
import { IncidentManager } from "./incidents/manager.js";
import { createGateway } from "./realtime/gateway.js";
import { ServiceRegistry } from "./registry.js";
import { Supervisor } from "./supervisor/supervisor.js";
import { connectStore } from "./store/db.js";
import * as repo from "./store/repository.js";

async function main(): Promise<void> {
  const store = await connectStore();
  const registry = await ServiceRegistry.load(store.db);

  const app = express();
  app.use(express.json({ limit: "256kb" }));
  const server = http.createServer(app);
  const gateway = createGateway(server);

  const latest = new Map<ServiceName, Snapshot>();
  const detector = createDetector(config.detector);

  const audit = async (entry: Omit<AuditEntry, "id" | "at">): Promise<void> => {
    const full: AuditEntry = { id: randomUUID(), at: new Date().toISOString(), ...entry };
    await repo.insertAudit(store.db, full);
    gateway.publish("audit", full);
  };

  const manager = new IncidentManager({
    saveIncident: (incident) => repo.saveIncident(store.db, incident),
    audit,
    publish: gateway.publish,
    dependencies: () => registry.dependencyMap(),
  });

  const supervisor = new Supervisor();
  process.on("exit", () => supervisor.stop());
  supervisor.start(registry.list(), config.healerUrl);

  registerRoutes(app, {
    db: store.db,
    registry,
    latestSnapshots: () => [...latest.values()],
    activeIncident: () => manager.current(),
    audit,
  });

  await new Promise<void>((resolve) => server.listen(config.healerPort, resolve));
  console.log(`[healer] API and realtime on http://localhost:${config.healerPort}`);

  await waitForServices(registry.list(), config.readyTimeoutMs);
  console.log("[healer] demo services are ready, collecting signals");

  const collector = startCollector({
    intervalMs: config.collectIntervalMs,
    getServices: () => registry.list(),
    onSnapshots: async (snapshots) => {
      for (const snapshot of snapshots) {
        latest.set(snapshot.service, snapshot);
        await repo.insertSnapshot(store.db, snapshot);
        gateway.publish("snapshot", snapshot);
      }
      const anomalies = snapshots.flatMap((snapshot) => detector.observe(snapshot));
      await manager.observe(anomalies, new Date());
    },
  });

  const shutdown = async (): Promise<void> => {
    collector.stop();
    supervisor.stop();
    gateway.close();
    server.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error("[healer] failed to start", error);
  process.exit(1);
});
