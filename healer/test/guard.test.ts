import { describe, expect, it } from "vitest";
import { RemediationGuard } from "../src/remediate/guard.js";

const options = {
  cooldownBaseMs: 30_000,
  cooldownMaxMs: 120_000,
  backoffResetMs: 600_000,
  recurrenceWindowMs: 300_000,
  maxRepeats: 2,
  breakerResetMs: 900_000,
};

function guard() {
  const clock = { now: 1_000_000 };
  return { clock, instance: new RemediationGuard(options, () => clock.now) };
}

describe("remediation guard", () => {
  it("allows the first action on a service", () => {
    const { instance } = guard();
    expect(instance.check("payments", "gray")).toEqual({ allowed: true });
  });

  it("cools a service down after an action, then lets it be acted on again", () => {
    const { instance, clock } = guard();
    instance.recordAction("payments", "gray");
    const decision = instance.check("payments", "gray");
    expect(decision).toMatchObject({ allowed: false, kind: "cooldown", waitMs: 30_000 });
    clock.now += 30_000;
    expect(instance.check("payments", "gray").allowed).toBe(true);
  });

  it("only cools down the service that was touched", () => {
    const { instance } = guard();
    instance.recordAction("payments", "gray");
    expect(instance.check("inventory", "gray").allowed).toBe(true);
  });

  it("doubles the cooldown for each recent action, up to the maximum", () => {
    const { instance, clock } = guard();
    const waits: number[] = [];
    for (const failure of ["gray", "crash", "slow", "memory_leak"] as const) {
      instance.recordAction("payments", failure);
      const decision = instance.check("payments", "bad_config");
      waits.push(decision.allowed || decision.kind !== "cooldown" ? 0 : decision.waitMs);
      clock.now += 1_000;
    }
    expect(waits).toEqual([30_000, 60_000, 120_000, 120_000]);
  });

  it("resets the backoff after a quiet period", () => {
    const { instance, clock } = guard();
    instance.recordAction("payments", "gray");
    instance.recordAction("payments", "crash");
    clock.now += options.backoffResetMs + 1;
    instance.recordAction("payments", "slow");
    expect(instance.check("payments", "bad_config")).toMatchObject({ kind: "cooldown", waitMs: 30_000 });
  });

  it("opens the breaker once the same fix was applied the maximum number of times", () => {
    const { instance, clock } = guard();
    instance.recordAction("payments", "gray");
    clock.now += 60_000;
    instance.recordAction("payments", "gray");
    clock.now += 120_000;
    const decision = instance.check("payments", "gray");
    expect(decision).toMatchObject({ allowed: false, kind: "breaker" });
    expect(instance.status()[0]).toMatchObject({ service: "payments", breaker: "open" });
  });

  it("half-opens after the reset period and re-opens on the next repeat", () => {
    const { instance, clock } = guard();
    instance.recordAction("payments", "gray");
    instance.recordAction("payments", "gray");
    instance.check("payments", "gray");
    clock.now += options.breakerResetMs;
    expect(instance.check("payments", "gray").allowed).toBe(true);
    expect(instance.status()[0].breaker).toBe("half_open");
    instance.recordAction("payments", "gray");
    clock.now += options.cooldownBaseMs * 4;
    expect(instance.check("payments", "gray")).toMatchObject({ kind: "breaker" });
  });

  it("finds the last fix of the same failure inside the recurrence window", () => {
    const { instance, clock } = guard();
    instance.recordResolution("payments", { incidentId: "i1", attemptId: "a1", failure: "gray" });
    clock.now += 10_000;
    instance.recordResolution("payments", { incidentId: "i2", attemptId: "a2", failure: "gray" });
    expect(instance.lastResolution("payments", "gray")).toMatchObject({ incidentId: "i2", count: 2 });
    expect(instance.lastResolution("payments", "crash")).toBeNull();
    clock.now += options.recurrenceWindowMs + 1;
    expect(instance.lastResolution("payments", "gray")).toBeNull();
  });

  it("clears one service on reset", () => {
    const { instance } = guard();
    instance.recordAction("payments", "gray");
    instance.recordAction("payments", "gray");
    instance.check("payments", "gray");
    instance.reset("payments");
    expect(instance.check("payments", "gray").allowed).toBe(true);
  });
});
