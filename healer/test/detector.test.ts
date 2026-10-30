import { describe, expect, it } from "vitest";
import type { Snapshot } from "@nightshift/shared";
import { createDetector } from "../src/detect/detector.js";

const thresholds = {
  errorRate: 0.05,
  minRequests: 5,
  p95LatencyMs: 1000,
  memoryMb: 250,
  consecutiveSamples: 2,
};

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    service: "payments",
    at: "2026-10-30T10:00:00.000Z",
    reachable: true,
    healthy: true,
    errorRate: 0,
    p95LatencyMs: 20,
    slowRate: 0,
    memoryMb: 60,
    requests: 100,
    activeFault: null,
    configMode: "ok",
    ...overrides,
  };
}

describe("incident detector", () => {
  it("does not raise an anomaly from a single bad sample", () => {
    const detector = createDetector(thresholds);
    expect(detector.observe(snapshot({ errorRate: 0.5 }))).toEqual([]);
  });

  it("raises an error-rate anomaly after two consecutive bad samples", () => {
    const detector = createDetector(thresholds);
    detector.observe(snapshot({ errorRate: 0.5 }));
    const anomalies = detector.observe(snapshot({ errorRate: 0.5 }));
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ service: "payments", kind: "error_rate" });
  });

  it("resets the streak when a sample recovers", () => {
    const detector = createDetector(thresholds);
    detector.observe(snapshot({ errorRate: 0.5 }));
    detector.observe(snapshot({ errorRate: 0 }));
    expect(detector.observe(snapshot({ errorRate: 0.5 }))).toEqual([]);
  });

  it("ignores an error rate computed from too few requests", () => {
    const detector = createDetector(thresholds);
    detector.observe(snapshot({ errorRate: 1, requests: 2 }));
    expect(detector.observe(snapshot({ errorRate: 1, requests: 2 }))).toEqual([]);
  });

  it("raises an unreachable anomaly after two consecutive failed probes", () => {
    const detector = createDetector(thresholds);
    const down = snapshot({ reachable: false, healthy: false, requests: 0 });
    detector.observe(down);
    const anomalies = detector.observe(down);
    expect(anomalies.map((anomaly) => anomaly.kind)).toEqual(["unreachable"]);
  });

  it("raises latency and memory anomalies independently", () => {
    const detector = createDetector(thresholds);
    const slow = snapshot({ p95LatencyMs: 2100, memoryMb: 300 });
    detector.observe(slow);
    const kinds = detector.observe(slow).map((anomaly) => anomaly.kind).sort();
    expect(kinds).toEqual(["latency", "memory"]);
  });
});

describe("gray failure detection", () => {
  const withGray = {
    ...thresholds,
    gray: { errorRate: 0.05, slowRate: 0.05, maxFraction: 0.9, consecutiveSamples: 3 },
  };

  function grayKinds(sample: Snapshot, times = 3): string[] {
    const detector = createDetector(withGray);
    let anomalies: ReturnType<typeof detector.observe> = [];
    for (let i = 0; i < times; i += 1) anomalies = detector.observe(sample);
    return anomalies.filter((anomaly) => anomaly.kind === "gray").map((anomaly) => anomaly.kind);
  }

  it("flags a service that passes its health check while 20% of requests fail", () => {
    expect(grayKinds(snapshot({ healthy: true, errorRate: 0.2 }))).toEqual(["gray"]);
  });

  it("flags a service whose health check passes while 15% of requests are slow", () => {
    expect(grayKinds(snapshot({ healthy: true, slowRate: 0.15 }))).toEqual(["gray"]);
  });

  it("needs three bad samples in a row because gray signals are noisy", () => {
    expect(grayKinds(snapshot({ healthy: true, errorRate: 0.2 }), 2)).toEqual([]);
  });

  it("stays quiet below the thresholds", () => {
    expect(grayKinds(snapshot({ healthy: true, errorRate: 0.02, slowRate: 0.03 }))).toEqual([]);
  });

  it("does not call a failing health check or a total outage gray", () => {
    expect(grayKinds(snapshot({ healthy: false, errorRate: 0.2 }))).toEqual([]);
    expect(grayKinds(snapshot({ healthy: true, errorRate: 1 }))).toEqual([]);
  });
});
