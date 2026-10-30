import { ANOMALY_KINDS, type Anomaly, type AnomalyKind, type Snapshot } from "@nightshift/shared";

export interface DetectorThresholds {
  errorRate: number;
  minRequests: number;
  p95LatencyMs: number;
  memoryMb: number;
  consecutiveSamples: number;
  gray?: GrayThresholds;
}

// Gray failure: /health says ok, but a fraction of users get errors or slow answers.
// A total outage is not gray, so fractions above maxFraction are left to the other kinds.
export interface GrayThresholds {
  errorRate: number;
  slowRate: number;
  maxFraction: number;
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
  const gray = grayBreach(snapshot, thresholds);
  if (gray) breaches.push(gray);
  return breaches;
}

function grayBreach(snapshot: Snapshot, thresholds: DetectorThresholds): Breach | null {
  const gray = thresholds.gray;
  if (!gray || !snapshot.healthy || snapshot.requests < thresholds.minRequests) return null;
  const partial = (value: number, threshold: number) => value >= threshold && value < gray.maxFraction;
  if (partial(snapshot.errorRate, gray.errorRate)) {
    return { kind: "gray", value: snapshot.errorRate, threshold: gray.errorRate };
  }
  if (partial(snapshot.slowRate, gray.slowRate)) {
    return { kind: "gray", value: snapshot.slowRate, threshold: gray.slowRate };
  }
  return null;
}

export function createDetector(thresholds: DetectorThresholds) {
  const streaks = new Map<string, { count: number; since: string }>();

  return {
    reset(): void {
      streaks.clear();
    },

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
        const needed =
          breach.kind === "gray" && thresholds.gray ? thresholds.gray.consecutiveSamples : thresholds.consecutiveSamples;
        if (next.count >= needed) {
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
