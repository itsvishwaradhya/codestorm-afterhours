import type { ServiceRecord, ServiceStatus, Snapshot } from "@nightshift/shared";

const PROBE_TIMEOUT_MS = 1000;

export async function probeService(service: ServiceRecord, at: Date = new Date()): Promise<Snapshot> {
  const base = `http://localhost:${service.port}`;
  const timestamp = at.toISOString();
  try {
    const [health, metricsResponse] = await Promise.all([
      fetch(`${base}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }),
      fetch(`${base}/metrics`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }),
    ]);
    const healthy = health.ok;
    await health.text();
    const status = (await metricsResponse.json()) as ServiceStatus;
    return {
      service: service.name,
      at: timestamp,
      reachable: true,
      healthy,
      errorRate: status.metrics.errorRate,
      p95LatencyMs: status.metrics.p95LatencyMs,
      memoryMb: status.metrics.memoryMb,
      requests: status.metrics.requests,
      activeFault: status.activeFault,
      configMode: status.config.mode,
    };
  } catch {
    return {
      service: service.name,
      at: timestamp,
      reachable: false,
      healthy: false,
      errorRate: 0,
      p95LatencyMs: 0,
      memoryMb: 0,
      requests: 0,
      activeFault: null,
      configMode: "unknown",
    };
  }
}

export async function waitForServices(services: ServiceRecord[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (const service of services) {
    for (;;) {
      const snapshot = await probeService(service);
      if (snapshot.reachable) break;
      if (Date.now() > deadline) {
        throw new Error(`${service.name} did not become ready within ${timeoutMs} ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

export interface CollectorOptions {
  intervalMs: number;
  getServices: () => ServiceRecord[];
  onSnapshots: (snapshots: Snapshot[]) => Promise<void>;
}

export function startCollector(options: CollectorOptions): { stop: () => void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    const at = new Date();
    Promise.all(options.getServices().map((service) => probeService(service, at)))
      .then((snapshots) => options.onSnapshots(snapshots))
      .catch((error) => console.error("[collector] tick failed", error))
      .finally(() => {
        running = false;
      });
  }, options.intervalMs);
  return { stop: () => clearInterval(timer) };
}
