import type { Anomaly, RankedCause, ServiceName } from "@nightshift/shared";

export interface Diagnosis {
  rootCause: ServiceName | null;
  symptoms: ServiceName[];
  causes: RankedCause[];
}

type Dependencies = Record<ServiceName, readonly ServiceName[]>;

interface Entry {
  service: ServiceName;
  explainedBy: ServiceName | null;
  down: boolean;
  magnitude: number;
  kinds: string[];
}

function transitiveDependencies(service: ServiceName, dependencies: Dependencies): ServiceName[] {
  const seen = new Set<ServiceName>();
  const stack = [...(dependencies[service] ?? [])];
  while (stack.length > 0) {
    const next = stack.pop() as ServiceName;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(dependencies[next] ?? []));
  }
  return [...seen];
}

function reasonFor(entry: Entry): string {
  const kinds = entry.kinds.join(", ");
  if (entry.explainedBy === null) {
    return `${entry.service} is failing (${kinds}) and none of its dependencies are anomalous`;
  }
  return `${entry.service} is failing (${kinds}), likely caused by ${entry.explainedBy}, which is anomalous`;
}

export function diagnose(anomalies: Anomaly[], dependencies: Dependencies): Diagnosis {
  const bySource = new Map<ServiceName, Anomaly[]>();
  for (const anomaly of anomalies) {
    bySource.set(anomaly.service, [...(bySource.get(anomaly.service) ?? []), anomaly]);
  }

  const anomalous = new Set(bySource.keys());
  const entries: Entry[] = [...bySource.entries()].map(([service, list]) => ({
    service,
    explainedBy: transitiveDependencies(service, dependencies).find((dep) => anomalous.has(dep)) ?? null,
    down: list.some((anomaly) => anomaly.kind === "unreachable" || anomaly.kind === "unhealthy"),
    magnitude: Math.max(...list.map((anomaly) => anomaly.value / anomaly.threshold)),
    kinds: list.map((anomaly) => anomaly.kind),
  }));

  entries.sort(
    (a, b) =>
      Number(a.explainedBy !== null) - Number(b.explainedBy !== null) ||
      Number(b.down) - Number(a.down) ||
      b.magnitude - a.magnitude ||
      a.service.localeCompare(b.service),
  );

  const rootCause = entries.find((entry) => entry.explainedBy === null)?.service ?? null;
  return {
    rootCause,
    symptoms: entries.filter((entry) => entry.service !== rootCause).map((entry) => entry.service),
    causes: entries.map((entry) => ({
      service: entry.service,
      explainedBy: entry.explainedBy,
      reason: reasonFor(entry),
    })),
  };
}
