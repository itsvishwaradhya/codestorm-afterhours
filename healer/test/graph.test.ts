import { describe, expect, it } from "vitest";
import { SERVICE_DEPENDENCIES, type Anomaly, type ServiceName } from "@nightshift/shared";
import { diagnose } from "../src/diagnose/graph.js";

function anomaly(service: ServiceName, kind: Anomaly["kind"], value = 1, threshold = 1): Anomaly {
  return { service, kind, value, threshold, since: "2026-10-30T10:00:00.000Z" };
}

describe("root-cause graph", () => {
  it("names the downstream service as root cause when the upstream one is only a symptom", () => {
    const diagnosis = diagnose(
      [anomaly("orders", "error_rate", 0.6, 0.05), anomaly("payments", "unhealthy", 0, 1)],
      SERVICE_DEPENDENCIES,
    );
    expect(diagnosis.rootCause).toBe("payments");
    expect(diagnosis.symptoms).toEqual(["orders"]);
    expect(diagnosis.causes.find((cause) => cause.service === "orders")?.explainedBy).toBe("payments");
  });

  it("names orders as root cause when nothing it depends on is anomalous", () => {
    const diagnosis = diagnose([anomaly("orders", "latency", 2000, 1000)], SERVICE_DEPENDENCIES);
    expect(diagnosis.rootCause).toBe("orders");
    expect(diagnosis.symptoms).toEqual([]);
  });

  it("explains a symptom through a transitive dependency", () => {
    const chain = { orders: ["payments"], payments: ["inventory"], inventory: [] } as Record<
      ServiceName,
      ServiceName[]
    >;
    const diagnosis = diagnose(
      [anomaly("orders", "error_rate", 0.5, 0.05), anomaly("inventory", "memory", 300, 250)],
      chain,
    );
    expect(diagnosis.rootCause).toBe("inventory");
    expect(diagnosis.causes.find((cause) => cause.service === "orders")?.explainedBy).toBe("inventory");
  });

  it("ranks a down service above a degraded one when neither is explained", () => {
    const diagnosis = diagnose(
      [anomaly("payments", "error_rate", 0.2, 0.05), anomaly("inventory", "unreachable", 0, 1)],
      { orders: [], payments: [], inventory: [] },
    );
    expect(diagnosis.rootCause).toBe("inventory");
  });

  it("returns no root cause when there are no anomalies", () => {
    const diagnosis = diagnose([], SERVICE_DEPENDENCIES);
    expect(diagnosis.rootCause).toBeNull();
    expect(diagnosis.symptoms).toEqual([]);
    expect(diagnosis.causes).toEqual([]);
  });
});
