import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { decideVerdict } from "../src/verify/verdict.js";
import { summarize } from "../src/verify/replay.js";

const rules = config.verdict;

describe("shadow verdict", () => {
  it("promotes a candidate that clearly beats the baseline", () => {
    const decision = decideVerdict(
      { requests: 100, errorRate: 0.5, p95LatencyMs: 2000 },
      { requests: 120, errorRate: 0, p95LatencyMs: 12 },
      rules,
    );
    expect(decision.verdict).toBe("promote");
  });

  it("rejects a candidate that still fails too often", () => {
    const decision = decideVerdict(
      { requests: 100, errorRate: 0.5, p95LatencyMs: 20 },
      { requests: 120, errorRate: 0.3, p95LatencyMs: 10 },
      rules,
    );
    expect(decision.verdict).toBe("reject");
    expect(decision.reasons.join(" ")).toMatch(/error rate/);
  });

  it("rejects a candidate that is slower than the baseline", () => {
    const decision = decideVerdict(
      { requests: 100, errorRate: 0.5, p95LatencyMs: 20 },
      { requests: 120, errorRate: 0, p95LatencyMs: 800 },
      rules,
    );
    expect(decision.verdict).toBe("reject");
    expect(decision.reasons.join(" ")).toMatch(/p95 latency/);
  });

  it("uses the 1% ceiling when the baseline has no errors", () => {
    const clean = { requests: 100, errorRate: 0, p95LatencyMs: 20 };
    expect(decideVerdict(clean, { requests: 100, errorRate: 0.005, p95LatencyMs: 20 }, rules).verdict).toBe(
      "promote",
    );
    expect(decideVerdict(clean, { requests: 100, errorRate: 0.02, p95LatencyMs: 20 }, rules).verdict).toBe(
      "reject",
    );
  });

  it("does not reject latency noise from a freshly started clone below the floor", () => {
    const decision = decideVerdict(
      { requests: 100, errorRate: 1, p95LatencyMs: 0 },
      { requests: 120, errorRate: 0, p95LatencyMs: 51 },
      rules,
    );
    expect(decision.verdict).toBe("promote");
  });

  it("returns insufficient evidence for a small replay sample", () => {
    const decision = decideVerdict(
      { requests: 100, errorRate: 0.5, p95LatencyMs: 20 },
      { requests: 10, errorRate: 0, p95LatencyMs: 5 },
      rules,
    );
    expect(decision.verdict).toBe("insufficient evidence");
  });
});

describe("replay summary", () => {
  it("counts failures and takes the p95 latency", () => {
    const results = Array.from({ length: 20 }, (_, index) => ({ ok: index !== 0, latencyMs: index + 1 }));
    const summary = summarize(results);
    expect(summary.requests).toBe(20);
    expect(summary.errorRate).toBeCloseTo(0.05);
    expect(summary.p95LatencyMs).toBe(19);
  });

  it("returns zeros for an empty replay", () => {
    expect(summarize([])).toEqual({ requests: 0, errorRate: 0, p95LatencyMs: 0 });
  });
});
