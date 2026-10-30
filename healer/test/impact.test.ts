import { describe, expect, it } from "vitest";
import { assessImpact } from "../src/remediate/impact.js";

const rules = { errorRateDelta: 0.02, slowRateDelta: 0.05, latencyFactor: 1.5, latencyFloorMs: 500, minRequests: 5 };
const gray = { requests: 120, errorRate: 0.2, p95LatencyMs: 40, slowRate: 0 };

describe("action impact", () => {
  it("calls a fix that cut the error rate helped, and still notes the downtime it cost", () => {
    const result = assessImpact(gray, { requests: 60, errorRate: 0, p95LatencyMs: 30, slowRate: 0 }, 1500, rules);
    expect(result.impact).toBe("helped");
    expect(result.reasons.join(" ")).toContain("1.5 s of downtime");
  });

  it("calls a fix that cut slow requests helped", () => {
    const before = { requests: 100, errorRate: 0, p95LatencyMs: 2000, slowRate: 0.2 };
    const result = assessImpact(before, { requests: 60, errorRate: 0, p95LatencyMs: 30, slowRate: 0 }, 0, rules);
    expect(result.impact).toBe("helped");
  });

  it("calls a fix that made errors worse hurt", () => {
    const result = assessImpact(gray, { requests: 60, errorRate: 0.4, p95LatencyMs: 30, slowRate: 0 }, 0, rules);
    expect(result.impact).toBe("hurt");
  });

  it("calls a fix that made latency worse hurt", () => {
    const result = assessImpact(gray, { requests: 60, errorRate: 0.2, p95LatencyMs: 900, slowRate: 0 }, 0, rules);
    expect(result.impact).toBe("hurt");
  });

  it("calls a restart that changed nothing hurt, because the downtime was for nothing", () => {
    const result = assessImpact(gray, { ...gray, requests: 60 }, 2000, rules);
    expect(result.impact).toBe("hurt");
    expect(result.reasons[0]).toBe("nothing measurably improved");
  });

  it("calls a config change that changed nothing no effect", () => {
    expect(assessImpact(gray, { ...gray, requests: 60 }, 0, rules).impact).toBe("no_effect");
  });

  it("calls an action after which production stopped answering hurt", () => {
    expect(assessImpact(gray, null, 0, rules).impact).toBe("hurt");
  });

  it("does not judge on too little traffic", () => {
    const result = assessImpact(gray, { requests: 2, errorRate: 0, p95LatencyMs: 10, slowRate: 0 }, 0, rules);
    expect(result.impact).toBe("no_effect");
    expect(result.reasons[0]).toMatch(/too few to judge/);
  });
});
