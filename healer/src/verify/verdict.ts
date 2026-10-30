import type { WindowMetrics } from "@nightshift/shared";

export interface VerdictRules {
  minSampleSize: number;
  maxCandidateErrorRate: number;
  reductionFactor: number;
  latencyFloorMs: number;
}

export interface Decision {
  verdict: "promote" | "reject" | "insufficient evidence";
  reasons: string[];
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function decideVerdict(
  baseline: WindowMetrics,
  candidate: WindowMetrics,
  rules: VerdictRules,
): Decision {
  if (candidate.requests < rules.minSampleSize) {
    return {
      verdict: "insufficient evidence",
      reasons: [`only ${candidate.requests} replayed requests, need ${rules.minSampleSize}`],
    };
  }

  const reasons: string[] = [];
  const relativeCeiling =
    baseline.errorRate === 0 ? Number.POSITIVE_INFINITY : baseline.errorRate * rules.reductionFactor;
  const errorCeiling = Math.min(rules.maxCandidateErrorRate, relativeCeiling);
  if (candidate.errorRate > errorCeiling) {
    reasons.push(
      `error rate ${percent(candidate.errorRate)} is above the limit of ${percent(errorCeiling)}`,
    );
  }

  const latencyLimit = Math.max(baseline.p95LatencyMs, rules.latencyFloorMs);
  if (candidate.p95LatencyMs > latencyLimit) {
    reasons.push(`p95 latency ${candidate.p95LatencyMs} ms is above the limit of ${latencyLimit} ms`);
  }

  if (reasons.length > 0) {
    return { verdict: "reject", reasons };
  }
  return {
    verdict: "promote",
    reasons: [
      `error rate ${percent(candidate.errorRate)} against baseline ${percent(baseline.errorRate)}`,
      `p95 latency ${candidate.p95LatencyMs} ms against baseline ${baseline.p95LatencyMs} ms`,
    ],
  };
}
