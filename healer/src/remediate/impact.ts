import type { Impact, WindowMetrics } from "@nightshift/shared";

export interface ImpactRules {
  errorRateDelta: number;
  slowRateDelta: number;
  latencyFactor: number;
  latencyFloorMs: number;
  minRequests: number;
}

export interface ImpactAssessment {
  impact: Exclude<Impact, "temporary">;
  reasons: string[];
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

// Compares production before and after an automatic action. A restart that changed nothing
// still cost downtime, so it counts as hurt rather than harmless.
export function assessImpact(
  before: WindowMetrics,
  after: WindowMetrics | null,
  downtimeMs: number,
  rules: ImpactRules,
): ImpactAssessment {
  const downtime = downtimeMs > 0 ? [`the action caused ${(downtimeMs / 1000).toFixed(1)} s of downtime`] : [];
  if (!after) {
    return { impact: "hurt", reasons: ["production did not answer after the action", ...downtime] };
  }
  if (after.requests < rules.minRequests) {
    return {
      impact: "no_effect",
      reasons: [`only ${after.requests} production requests after the action, too few to judge`, ...downtime],
    };
  }

  const worse: string[] = [];
  const better: string[] = [];
  const errorDelta = after.errorRate - before.errorRate;
  const errorLine = `error rate ${percent(before.errorRate)} -> ${percent(after.errorRate)}`;
  if (errorDelta >= rules.errorRateDelta) worse.push(errorLine);
  if (errorDelta <= -rules.errorRateDelta) better.push(errorLine);

  const slowBefore = before.slowRate ?? 0;
  const slowAfter = after.slowRate ?? 0;
  const slowLine = `slow requests ${percent(slowBefore)} -> ${percent(slowAfter)}`;
  if (slowAfter - slowBefore >= rules.slowRateDelta) worse.push(slowLine);
  if (slowAfter - slowBefore <= -rules.slowRateDelta) better.push(slowLine);

  const latencyLine = `p95 latency ${Math.round(before.p95LatencyMs)} ms -> ${Math.round(after.p95LatencyMs)} ms`;
  if (after.p95LatencyMs > Math.max(before.p95LatencyMs * rules.latencyFactor, rules.latencyFloorMs)) {
    worse.push(latencyLine);
  } else if (
    before.p95LatencyMs > rules.latencyFloorMs &&
    after.p95LatencyMs * rules.latencyFactor < before.p95LatencyMs
  ) {
    better.push(latencyLine);
  }

  if (worse.length > 0) return { impact: "hurt", reasons: [...worse, ...downtime] };
  if (better.length > 0) return { impact: "helped", reasons: [...better, ...downtime] };
  if (downtimeMs > 0) {
    return { impact: "hurt", reasons: ["nothing measurably improved", ...downtime] };
  }
  return { impact: "no_effect", reasons: ["nothing measurably changed"] };
}
