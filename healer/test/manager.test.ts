import { describe, expect, it } from "vitest";
import { SERVICE_DEPENDENCIES, type Anomaly, type Incident } from "@nightshift/shared";
import { IncidentManager } from "../src/incidents/manager.js";

const at = new Date("2026-10-30T10:00:00.000Z");

function anomaly(service: Anomaly["service"], kind: Anomaly["kind"]): Anomaly {
  return { service, kind, value: 1, threshold: 1, since: at.toISOString() };
}

function manager() {
  const started: Incident[] = [];
  const instance = new IncidentManager({
    persist: async () => {},
    audit: async () => {},
    dependencies: () => ({ ...SERVICE_DEPENDENCIES }),
    startRemediation: (incident) => {
      started.push(structuredClone(incident));
    },
    isRemediating: () => false,
  });
  return { instance, started };
}

describe("incident manager", () => {
  it("waits for a stable diagnosis before starting remediation", async () => {
    const { instance, started } = manager();
    await instance.observe([anomaly("inventory", "memory"), anomaly("orders", "error_rate")], at);
    expect(started).toHaveLength(0);
    await instance.observe([anomaly("inventory", "memory"), anomaly("orders", "error_rate")], at);
    expect(started).toHaveLength(1);
    expect(started[0].rootCause).toBe("inventory");
  });

  it("keeps the diagnosed root cause after remediation starts, even if anomalies change", async () => {
    const { instance, started } = manager();
    const both = [anomaly("inventory", "memory"), anomaly("orders", "error_rate")];
    await instance.observe(both, at);
    await instance.observe(both, at);
    await instance.observe([anomaly("orders", "error_rate")], at);
    expect(started).toHaveLength(1);
    expect(instance.current()?.rootCause).toBe("inventory");
  });

  it("starts a new incident for a fresh fault after the previous one cleared", async () => {
    const { instance, started } = manager();
    const payments = [anomaly("payments", "unreachable")];
    await instance.observe(payments, at);
    await instance.observe(payments, at);
    expect(started).toHaveLength(1);
    await instance.observe([], at);
    expect(instance.current()).toBeNull();
    await instance.observe(payments, at);
    await instance.observe(payments, at);
    expect(started).toHaveLength(2);
    expect(started[1].id).not.toBe(started[0].id);
  });
});
