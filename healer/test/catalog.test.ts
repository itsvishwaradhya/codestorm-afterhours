import { describe, expect, it } from "vitest";
import type { Anomaly } from "@nightshift/shared";
import { candidatesFor, classifyFailure } from "../src/fix/catalog.js";

function anomaly(kind: Anomaly["kind"]): Anomaly {
  return { service: "payments", kind, value: 1, threshold: 1, since: "2026-10-30T10:00:00.000Z" };
}

describe("failure classification", () => {
  it("classifies an unreachable service as a crash", () => {
    expect(classifyFailure([anomaly("unreachable")], "unknown")).toBe("crash");
  });

  it("classifies a corrupt configuration as bad config before generic health", () => {
    expect(classifyFailure([anomaly("unhealthy"), anomaly("error_rate")], "corrupt")).toBe("bad_config");
  });

  it("classifies memory and latency anomalies", () => {
    expect(classifyFailure([anomaly("memory")], "ok")).toBe("memory_leak");
    expect(classifyFailure([anomaly("latency")], "ok")).toBe("slow");
  });

  it("returns null for an unknown pattern", () => {
    expect(classifyFailure([anomaly("error_rate")], "ok")).toBeNull();
  });
});

describe("fix candidates", () => {
  it("orders bad-config candidates from safest to riskiest", () => {
    const ids = candidatesFor("bad_config", ["restart", "revert_config", "reset_defaults", "apply_stale_snapshot"]).map(
      (candidate) => candidate.id,
    );
    expect(ids).toEqual(["revert_config", "apply_stale_snapshot", "reset_defaults"]);
  });

  it("skips candidates that the service does not allow", () => {
    const ids = candidatesFor("bad_config", ["reset_defaults"]).map((candidate) => candidate.id);
    expect(ids).toEqual(["reset_defaults"]);
  });

  it("offers a restart for crash, memory and slow failures", () => {
    expect(candidatesFor("crash", ["restart"]).map((candidate) => candidate.id)).toEqual(["restart"]);
    expect(candidatesFor("memory_leak", ["restart"]).map((candidate) => candidate.id)).toEqual(["restart"]);
    expect(candidatesFor("slow", ["restart"]).map((candidate) => candidate.id)).toEqual(["restart"]);
  });

  it("marks the demo decoy as never allowed in production", () => {
    const decoy = candidatesFor("bad_config", ["apply_stale_snapshot"])[0];
    expect(decoy.productionAllowed).toBe(false);
  });
});
