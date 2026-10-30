import { ANOMALY_KINDS, type Anomaly, type AnomalyKind, type Snapshot } from "@nightshift/shared";

export interface DetectorThresholds {
  errorRate: number;
  minRequests: number;
  p95LatencyMs: number;
  memoryMb: number;
  consecutiveSamples: number;
}

interface Breach {
  kind: AnomalyKind;
  value: number;
  threshold: number;
}

export function breachesOf(snapshot: Snapshot, thresholds: DetectorThresholds): Breach[] {
  if (!snapshot.reachable) {
    return [{ kind: "unreachable", value: 0, threshold: 1 }];
  }
  const breaches: Breach[] = [];
  if (!snapshot.healthy) {
    breaches.push({ kind: "unhealthy", value: 0, threshold: 1 });
  }
  if (snapshot.requests >= thresholds.minRequests && snapshot.errorRate >= thresholds.errorRate) {
    breaches.push({ kind: "error_rate", value: snapshot.errorRate, threshold: thresholds.errorRate });
  }
  if (snapshot.p95LatencyMs >= thresholds.p95LatencyMs) {
    breaches.push({ kind: "latency", value: snapshot.p95LatencyMs, threshold: thresholds.p95LatencyMs });
  }
  if (snapshot.memoryMb >= thresholds.memoryMb) {
    breaches.push({ kind: "memory", value: snapshot.memoryMb, threshold: thresholds.memoryMb });
  }
  return breaches;
}

export function createDetector(thresholds: DetectorThresholds) {
  const streaks = new Map<string, { count: number; since: string }>();

  return {
    observe(snapshot: Snapshot): Anomaly[] {
      const breaches = breachesOf(snapshot, thresholds);
      const breachedKinds = new Set(breaches.map((breach) => breach.kind));

      for (const kind of ANOMALY_KINDS) {
        if (!breachedKinds.has(kind)) {
          streaks.delete(`${snapshot.service}:${kind}`);
        }
      }

      const active: Anomaly[] = [];
      for (const breach of breaches) {
        const key = `${snapshot.service}:${breach.kind}`;
        const previous = streaks.get(key) ?? { count: 0, since: snapshot.at };
        const next = { count: previous.count + 1, since: previous.since };
        streaks.set(key, next);
        if (next.count >= thresholds.consecutiveSamples) {
          active.push({
            service: snapshot.service,
            kind: breach.kind,
            value: breach.value,
            threshold: breach.threshold,
            since: next.since,
          });
        }
      }
      return active;
    },
  };
}
