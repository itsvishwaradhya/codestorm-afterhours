import { randomUUID } from "node:crypto";
import type { Attempt, ServiceName, ServiceRecord, ServiceStatus, WindowMetrics } from "@nightshift/shared";
import type { FixCandidate } from "../fix/catalog.js";
import { copyProductionState, runSteps, serviceUrl } from "../fix/steps.js";
import { decideVerdict, type Decision, type VerdictRules } from "./verdict.js";
import { replay, type ReplayRecord } from "./replay.js";

export interface CloneHandle {
  stop: () => Promise<void>;
}

export interface VerifierDeps {
  captures: (service: ServiceName, sinceIso: string) => Promise<ReplayRecord[]>;
  startClone: (service: ServiceRecord, port: number) => Promise<CloneHandle>;
  waitReady: (baseUrl: string, timeoutMs: number) => Promise<boolean>;
  allocatePort: () => number | null;
  releasePort: (port: number) => void;
  readStatus: (baseUrl: string) => Promise<ServiceStatus | null>;
  now: () => Date;
  rules: VerdictRules;
  replayWindowSeconds: number;
  replayConcurrency: number;
  cloneReadyTimeoutMs: number;
}

export class PortPool {
  private readonly used = new Set<number>();

  constructor(
    private readonly from: number,
    private readonly to: number,
  ) {}

  allocate(): number | null {
    for (let port = this.from; port <= this.to; port += 1) {
      if (!this.used.has(port)) {
        this.used.add(port);
        return port;
      }
    }
    return null;
  }

  release(port: number): void {
    this.used.delete(port);
  }
}

async function runShadow(
  deps: VerifierDeps,
  service: ServiceRecord,
  candidate: FixCandidate,
  production: ServiceStatus | null,
  port: number,
): Promise<{ decision: Decision; candidateMetrics: WindowMetrics }> {
  const empty: WindowMetrics = { requests: 0, errorRate: 0, p95LatencyMs: 0 };
  const baseline: WindowMetrics = production
    ? {
        requests: production.metrics.requests,
        errorRate: production.metrics.errorRate,
        p95LatencyMs: production.metrics.p95LatencyMs,
      }
    : { requests: 0, errorRate: 1, p95LatencyMs: 0 };
  let handle: CloneHandle | undefined;
  try {
    handle = await deps.startClone(service, port);
    const cloneUrl = serviceUrl(port);
    if (!(await deps.waitReady(cloneUrl, deps.cloneReadyTimeoutMs))) {
      return {
        decision: { verdict: "insufficient evidence", reasons: ["shadow clone did not start"] },
        candidateMetrics: empty,
      };
    }
    if (!candidate.startsFresh && production) {
      await copyProductionState(cloneUrl, production);
    }
    await runSteps(cloneUrl, candidate.steps);
    const since = new Date(deps.now().getTime() - deps.replayWindowSeconds * 1000).toISOString();
    const records = await deps.captures(service.name, since);
    const candidateMetrics = await replay(cloneUrl, records, deps.replayConcurrency);
    return {
      decision: decideVerdict(baseline, candidateMetrics, deps.rules),
      candidateMetrics,
    };
  } catch (error) {
    return {
      decision: {
        verdict: "insufficient evidence",
        reasons: [`shadow run failed: ${error instanceof Error ? error.message : String(error)}`],
      },
      candidateMetrics: empty,
    };
  } finally {
    if (handle) await handle.stop();
  }
}

export function createVerifier(deps: VerifierDeps) {
  return async function verify(
    service: ServiceRecord,
    incidentId: string,
    candidate: FixCandidate,
  ): Promise<Attempt> {
    const startedAt = deps.now().toISOString();
    const production = await deps.readStatus(serviceUrl(service.port));
    const baseline: WindowMetrics = production
      ? {
          requests: production.metrics.requests,
          errorRate: production.metrics.errorRate,
          p95LatencyMs: production.metrics.p95LatencyMs,
          slowRate: production.metrics.slowRate,
        }
      : { requests: 0, errorRate: 1, p95LatencyMs: 0 };

    const port = deps.allocatePort();
    let result: { decision: Decision; candidateMetrics: WindowMetrics };
    if (port === null) {
      result = {
        decision: { verdict: "insufficient evidence", reasons: ["no free shadow port"] },
        candidateMetrics: { requests: 0, errorRate: 0, p95LatencyMs: 0 },
      };
    } else {
      try {
        result = await runShadow(deps, service, candidate, production, port);
      } finally {
        deps.releasePort(port);
      }
    }

    return {
      id: randomUUID(),
      incidentId,
      candidate: candidate.id,
      label: candidate.label,
      risk: candidate.risk,
      verdict: result.decision.verdict,
      reasons: result.decision.reasons,
      baseline,
      candidateMetrics: result.candidateMetrics,
      sampleSize: result.candidateMetrics.requests,
      status: result.decision.verdict === "promote" ? "verified" : "rejected",
      startedAt,
      endedAt: deps.now().toISOString(),
    };
  };
}
