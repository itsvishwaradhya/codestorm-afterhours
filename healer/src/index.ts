import "./env.js";
import { randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import type { Attempt, AuditEntry, Incident, ServiceName, Snapshot } from "@nightshift/shared";
import { registerRoutes } from "./api/routes.js";
import { startCollector, waitForServices, type Collector } from "./collect/collector.js";
import { config } from "./config.js";
import { breachesOf, createDetector } from "./detect/detector.js";
import { candidatesFor, classifyFailure, type FixCandidate } from "./fix/catalog.js";
import {
  captureState,
  readStatus,
  readTotals,
  readWindow,
  restoreState,
  runSteps,
  serviceUrl,
  waitForUrl,
} from "./fix/steps.js";
import { IncidentManager } from "./incidents/manager.js";
import { createGateway } from "./realtime/gateway.js";
import { ServiceRegistry } from "./registry.js";
import { ApprovalGate } from "./remediate/approvals.js";
import { ActionCap } from "./remediate/cap.js";
import { RemediationGuard } from "./remediate/guard.js";
import { isTerminal, Remediator, type RemediationPlan } from "./remediate/remediator.js";
import { createProviders } from "./receipt/providers.js";
import { AppHealer } from "./app/healer.js";
import { ReceiptWriter } from "./receipt/writer.js";
import { watchService } from "./remediate/watch.js";
import { Supervisor, type LogLine } from "./supervisor/supervisor.js";
import { connectStore } from "./store/db.js";
import * as repo from "./store/repository.js";
import { fixtureFor } from "./verify/fixture.js";
import { createVerifier, PortPool } from "./verify/verifier.js";

type AuditInput = Omit<AuditEntry, "id" | "at">;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const store = await connectStore();
  const registry = await ServiceRegistry.load(store.db);

  const app = express();
  app.use(express.json({ limit: "256kb" }));
  const server = http.createServer(app);
  const gateway = createGateway(server);

  const latest = new Map<ServiceName, Snapshot>();
  const detector = createDetector(config.detector);

  const audit = async (entry: AuditInput): Promise<void> => {
    const full: AuditEntry = { id: randomUUID(), at: new Date().toISOString(), ...entry };
    await repo.insertAudit(store.db, full);
    gateway.publish("audit", full);
  };

  const receiptWriter = new ReceiptWriter({
    loadAttempts: (incidentId) => repo.listAttempts(store.db, incidentId),
    saveReceipt: async (receipt) => {
      await repo.saveReceipt(store.db, receipt);
      gateway.publish("receipt", receipt);
    },
    providers: createProviders(process.env),
    chain: { ...config.llm, log: (message) => console.log(message) },
    now: () => new Date(),
  });
  const receipted = new Set<string>();

  const persist = async (incident: Incident): Promise<void> => {
    await repo.saveIncident(store.db, incident);
    gateway.publish("incident", incident);
    if (isTerminal(incident.state) && !receipted.has(incident.id)) {
      receipted.add(incident.id);
      receiptWriter.write(incident).catch((error) => console.error("[receipt] failed", error));
    }
  };

  const auditIncident = (action: string, incident: Incident, details: Record<string, unknown>): Promise<void> =>
    audit({
      actor: "healer",
      action,
      trigger: String(details.note ?? action),
      incidentId: incident.id,
      details,
    });

  const approvals = new ApprovalGate(config.approvalTimeoutMs);
  const cap = new ActionCap(config.actionCap.max, config.actionCap.windowMs);
  const guard = new RemediationGuard(config.guard);
  const ports = new PortPool(config.clonePorts.from, config.clonePorts.to);
  // The last few hundred service log lines, so a workspace opened mid-demo is not blank.
  const recentLogs: LogLine[] = [];
  const supervisor = new Supervisor(config.healerUrl, (entry) => {
    recentLogs.push(entry);
    if (recentLogs.length > 300) recentLogs.shift();
    gateway.publish("log", entry);
  });
  process.on("exit", () => supervisor.stop());

  const appHealer = new AppHealer({
    providers: createProviders(process.env),
    publish: (channel, payload) => gateway.publish(channel, payload),
    audit,
  });
  appHealer.start();
  process.on("exit", () => appHealer.stop());

  const verify = createVerifier({
    captures: async (service, sinceIso) => {
      const records = await repo.listCapturesSince(store.db, service, sinceIso, config.replay.limit);
      if (records.length === 0) {
        console.log(`[verify] no captured requests for ${service} in the window, using the recorded fixture`);
        return fixtureFor(service);
      }
      if (records.length < config.verdict.minSampleSize) {
        console.log(
          `[verify] only ${records.length} captured requests for ${service}, repeating them to reach ${config.verdict.minSampleSize}`,
        );
        return Array.from(
          { length: config.verdict.minSampleSize },
          (_, index) => records[index % records.length],
        );
      }
      return records;
    },
    startClone: async (service, port) => supervisor.spawnClone(service, port),
    waitReady: waitForUrl,
    allocatePort: () => ports.allocate(),
    releasePort: (port) => ports.release(port),
    readStatus,
    now: () => new Date(),
    rules: config.verdict,
    replayWindowSeconds: config.replay.windowSeconds,
    replayConcurrency: config.replay.concurrency,
    cloneReadyTimeoutMs: config.cloneReadyTimeoutMs,
  });

  const planFor = (incident: Incident): RemediationPlan => {
    const root = incident.rootCause as ServiceName;
    const rootAnomalies = incident.anomalies.filter((anomaly) => anomaly.service === root);
    const configMode = latest.get(root)?.configMode ?? "unknown";
    const failure = classifyFailure(rootAnomalies, configMode);
    const candidates = failure ? candidatesFor(failure, registry.get(root).allowedFixTypes) : [];
    return { failure, candidates };
  };

  const applyToProduction = async (incident: Incident, candidate: FixCandidate): Promise<number> => {
    const record = registry.get(incident.rootCause as ServiceName);
    if (!candidate.productionAllowed) {
      throw new Error(`${candidate.id} is not allowed in production`);
    }
    if (candidate.startsFresh) {
      const started = Date.now();
      await supervisor.restart(record);
      if (!(await waitForUrl(serviceUrl(record.port), config.productionReadyTimeoutMs))) {
        throw new Error(`${record.name} did not come back after restart`);
      }
      return Date.now() - started;
    }
    await runSteps(serviceUrl(record.port), candidate.steps);
    return 0;
  };

  const remediator = new Remediator({
    plan: planFor,
    verify: (incident, candidate) => verify(registry.get(incident.rootCause as ServiceName), incident.id, candidate),
    saveAttempt: async (attempt: Attempt) => {
      await repo.saveAttempt(store.db, attempt);
      gateway.publish("attempt", attempt);
    },
    captureState: (service) => captureState(serviceUrl(registry.get(service).port)),
    restoreState: (service, state) => restoreState(serviceUrl(registry.get(service).port), state),
    applyToProduction,
    watch: (service, baseline) =>
      watchService({
        readTotals: () => readTotals(serviceUrl(registry.get(service).port)),
        preFixErrorRate: baseline.errorRate,
        preFixSlowRate: baseline.slowRate,
        minSlowRate: config.watch.minSlowRate,
        durationMs: config.watch.durationMs,
        intervalMs: config.watch.intervalMs,
        minRequests: config.watch.minRequests,
        minErrorRate: config.watch.minErrorRate,
        consecutive: config.watch.consecutive,
        sleep,
      }),
    readWindow: (service) => readWindow(serviceUrl(registry.get(service).port)),
    reviseAttempt: async (attemptId, patch) => {
      const updated = await repo.reviseAttemptImpact(
        store.db,
        attemptId,
        patch.impact ?? "temporary",
        patch.impactReasons ?? [],
      );
      if (updated) gateway.publish("attempt", updated);
    },
    stillFailing: (service) => {
      const snapshot = latest.get(service);
      return !snapshot || breachesOf(snapshot, config.detector).length > 0;
    },
    approvals,
    cap,
    guard,
    impactRules: config.impact,
    persist,
    audit: auditIncident,
    sleep,
    now: () => new Date(),
    capacityPollMs: config.capacityPollMs,
    capacityWaitMs: config.capacityWaitMs,
  });

  const manager = new IncidentManager({
    persist,
    audit,
    dependencies: () => registry.dependencyMap(),
    startRemediation: (incident) => {
      void remediator.run(incident);
    },
    isRemediating: () => remediator.isBusy(),
  });

  supervisor.start(registry.list());

  let resetting = false;
  let collector: Collector | null = null;

  const resetDemo = async (): Promise<boolean> => {
    if (remediator.isBusy() || resetting) return false;
    resetting = true;
    const paused = collector;
    await paused?.pause();
    try {
      detector.reset();
      manager.reset();
      cap.reset();
      guard.reset();
      latest.clear();
      receipted.clear();
      await registry.reset();
      await Promise.all(registry.list().map((service) => supervisor.restart(service)));
      await waitForServices(registry.list(), config.readyTimeoutMs);
      await repo.clearDemoData(store.db);
      detector.reset();
      manager.reset();
      await audit({
        actor: "operator",
        action: "demo.reset",
        trigger: "reset incidents, receipts, attempts and captures",
        incidentId: null,
        details: {},
      });
      return true;
    } finally {
      paused?.resume();
      resetting = false;
    }
  };

  registerRoutes(app, {
    db: store.db,
    registry,
    latestSnapshots: () => [...latest.values()],
    activeIncident: () => manager.current(),
    audit,
    approvals,
    cap,
    guard,
    reset: resetDemo,
    recentLogs: () => [...recentLogs],
    app: appHealer,
  });

  await new Promise<void>((resolve) => server.listen(config.healerPort, resolve));
  console.log(`[healer] API and realtime on http://localhost:${config.healerPort}`);

  await waitForServices(registry.list(), config.readyTimeoutMs);
  console.log("[healer] demo services are ready, collecting signals");

  collector = startCollector({
    intervalMs: config.collectIntervalMs,
    getServices: () => registry.list(),
    onSnapshots: async (snapshots) => {
      if (resetting) return;
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
    collector?.stop();
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
